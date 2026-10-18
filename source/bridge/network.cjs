"use strict";
const mqtt = require("mqtt"),
  { HttpsProxyAgent } = require("https-proxy-agent"),
  { EventEmitter } = require("node:events"),
  crypto = require("node:crypto");
const { retryDelay } = require("./state.cjs");
const PREFIX = "file-bridge/independent/v2";
class Endpoint extends EventEmitter {
  constructor({
    broker = "wss://broker.emqx.io:8084/mqtt",
    log = () => {},
    id,
  }) {
    super();
    const u = new URL(broker);
    if (u.protocol !== "wss:" || u.username || u.password)
      throw Error("WSS broker required");
    this.broker = u.href;
    this.log = log;
    this.id = id;
    this.topics = new Set();
    this.failures = 0;
    this.online = false;
    this.stopped = true;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }
  connect() {
    if (this.stopped) return;
    this.clear();
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const c = mqtt.connect(this.broker, {
      clientId: "fb2-" + crypto.randomBytes(16).toString("hex"),
      clean: true,
      reconnectPeriod: 0,
      connectTimeout: 15000,
      keepalive: 10,
      queueQoSZero: false,
      resubscribe: false,
      wsOptions: proxy ? { agent: new HttpsProxyAgent(proxy) } : {},
    });
    this.client = c;
    this.log("broker_connecting", { attempt: this.failures + 1 });
    let scheduled = false;
    const failed = () => {
      if (scheduled || this.stopped || this.client !== c) return;
      scheduled = true;
      this.online = false;
      clearTimeout(this.stable);
      c.end(true);
      const delay = retryDelay(++this.failures);
      this.log("broker_retry", { attempt: this.failures, delayMs: delay });
      this.emit("offline");
      this.timer = setTimeout(() => this.connect(), delay);
    };
    c.on("error", (e) =>
      this.log("broker_error", { reason: e.code || "transport_error" }),
    );
    c.on("close", failed);
    c.on("offline", failed);
    c.on("connect", () => {
      if (this.stopped || this.client !== c) return;
      const ready = () => {
        if (scheduled || this.stopped || this.client !== c) return;
        this.online = true;
        this.log("broker_online");
        this.emit("online");
        this.stable = setTimeout(() => {
          this.failures = 0;
        }, 30000);
        this.stable.unref();
      };
      if (this.topics.size)
        c.subscribe([...this.topics], { qos: 1 }, (e, granted) =>
          e || granted?.some((x) => x.qos >= 128) ? failed() : ready(),
        );
      else ready();
    });
    c.on("message", (topic, data) => {
      if (!this.stopped && this.client === c && data.length <= 150000)
        this.emit("message", topic, data.toString());
    });
  }
  subscribe(topic) {
    this.topics.add(topic);
    if (this.online)
      this.client.subscribe(topic, { qos: 1 }, (e) => {
        if (e) this.log("subscription_failed");
      });
  }
  unsubscribe(topic) {
    this.topics.delete(topic);
    if (this.online) this.client.unsubscribe(topic);
  }
  publish(topic, value) {
    if (!this.online) return false;
    this.client.publish(
      topic,
      typeof value === "string" ? value : JSON.stringify(value),
      { qos: 1, retain: false },
      (e) => {
        if (e)
          this.log("publish_failed", { reason: e.code || "transport_error" });
      },
    );
    return true;
  }
  clear() {
    clearTimeout(this.timer);
    clearTimeout(this.stable);
  }
  stop() {
    this.stopped = true;
    this.online = false;
    this.clear();
    this.client?.end(true);
  }
}
class Network extends EventEmitter {
  constructor(options = {}) {
    super();
    const brokers = options.broker
      ? [options.broker]
      : [
          "wss://test.mosquitto.org:8081/mqtt",
          "wss://broker.emqx.io:8084/mqtt",
        ];
    this.endpoints = brokers.map(
      (broker) =>
        new Endpoint({
          ...options,
          broker,
          log: (event, fields) =>
            options.log?.(event, {
              ...fields,
              endpoint: brokers.indexOf(broker),
            }),
        }),
    );
    this.online = false;
    for (const endpoint of this.endpoints) {
      endpoint.on("message", (t, d) => this.emit("message", t, d));
      endpoint.on("online", () => {
        const was = this.online;
        this.online = true;
        if (!was) this.emit("online");
      });
      endpoint.on("offline", () => {
        const was = this.online;
        this.online = this.endpoints.some((e) => e.online);
        if (was && !this.online) this.emit("offline");
      });
    }
  }
  get failures() {
    return Math.max(...this.endpoints.map((e) => e.failures));
  }
  get client() {
    return (
      this.endpoints.find((e) => e.online)?.client || this.endpoints[0].client
    );
  }
  start() {
    for (const e of this.endpoints) e.start();
  }
  stop() {
    for (const e of this.endpoints) e.stop();
    const was = this.online;
    this.online = false;
    if (was) this.emit("offline");
  }
  subscribe(t) {
    for (const e of this.endpoints) e.subscribe(t);
  }
  unsubscribe(t) {
    for (const e of this.endpoints) e.unsubscribe(t);
  }
  publish(t, d) {
    let sent = false;
    for (const e of this.endpoints) if (e.publish(t, d)) sent = true;
    return sent;
  }
}
module.exports = { Network, Endpoint, PREFIX };
