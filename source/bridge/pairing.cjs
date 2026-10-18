"use strict";
const opaque = require("@serenity-kit/opaque"),
  crypto = require("node:crypto");
const { PREFIX } = require("./network.cjs");
const { publicIdentity, validIdentity } = require("./state.cjs");
function wrap(key, context, value) {
  const iv = crypto.randomBytes(12),
    k = crypto
      .createHash("sha256")
      .update(key + context)
      .digest(),
    c = crypto.createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(Buffer.from(context));
  const data = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
  return {
    iv: iv.toString("base64"),
    tag: c.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
}
function unwrap(key, context, p) {
  if (!p || typeof p.data !== "string" || p.data.length > 20000)
    throw Error("Invalid envelope");
  const d = crypto.createDecipheriv(
    "aes-256-gcm",
    crypto
      .createHash("sha256")
      .update(key + context)
      .digest(),
    Buffer.from(p.iv, "base64"),
  );
  d.setAAD(Buffer.from(context));
  d.setAuthTag(Buffer.from(p.tag, "base64"));
  return JSON.parse(
    Buffer.concat([d.update(Buffer.from(p.data, "base64")), d.final()]),
  );
}
class Pairing {
  constructor({ network, identity, accept, log }) {
    Object.assign(this, { network, identity, accept, log });
    this.listener = (t, d) => {
      if (t.startsWith(PREFIX + "/pair/"))
        this.message(t, d).catch(() => this.log("pair_message_rejected"));
    };
    network.on("message", this.listener);
  }
  async offer() {
    await opaque.ready;
    this.cancelOffer();
    const room = crypto.randomBytes(6).toString("hex").toUpperCase(),
      password = crypto.randomBytes(6).toString("hex").toUpperCase(),
      code = room + "-" + password,
      topic = PREFIX + "/pair/" + room;
    const setup = opaque.server.createSetup(),
      reg = opaque.client.startRegistration({ password });
    const response = opaque.server.createRegistrationResponse({
      serverSetup: setup,
      userIdentifier: room,
      registrationRequest: reg.registrationRequest,
    });
    const { registrationRecord } = opaque.client.finishRegistration({
      ...reg,
      ...response,
      password,
    });
    const offer = {
      room,
      topic,
      code,
      setup,
      registrationRecord,
      attempts: new Map(),
      expiresAt: Date.now() + 300000,
    };
    this.offerState = offer;
    this.network.subscribe(topic);
    offer.timer = setTimeout(() => this.cancelOffer(), 300000);
    offer.timer.unref();
    this.log("pair_offer_created");
    return { code, expiresAt: offer.expiresAt };
  }
  cancelOffer() {
    const o = this.offerState;
    if (o) {
      clearTimeout(o.timer);
      this.network.unsubscribe(o.topic);
      this.offerState = null;
    }
  }
  async join(code) {
    await opaque.ready;
    if (this.joinState) throw Error("Pairing already in progress");
    code = String(code).replace(/\s/g, "").toUpperCase();
    if (!/^[A-F0-9]{12}-[A-F0-9]{12}$/.test(code))
      throw Error("Invalid pairing code");
    const [room, password] = code.split("-"),
      topic = PREFIX + "/pair/" + room,
      sid = crypto.randomUUID(),
      start = opaque.client.startLogin({ password });
    return new Promise((resolve, reject) => {
      const s = { room, password, topic, sid, start, resolve, reject };
      this.joinState = s;
      this.network.subscribe(topic);
      s.timer = setTimeout(
        () => this.endJoin(Error("Pairing timed out or code expired")),
        90000,
      );
      s.retry = setInterval(() => this.sendJoin(), 1500);
      this.sendJoin();
    });
  }
  sendJoin() {
    const s = this.joinState;
    if (!s) return;
    this.network.publish(s.topic, {
      side: "join",
      sid: s.sid,
      ...(s.finish
        ? {
            type: "finish",
            finish: s.finish.request,
            envelope: s.finish.envelope,
          }
        : { type: "hello", request: s.start.startLoginRequest }),
    });
  }
  endJoin(error, result) {
    const s = this.joinState;
    if (!s) return;
    clearTimeout(s.timer);
    clearInterval(s.retry);
    this.network.unsubscribe(s.topic);
    this.joinState = null;
    error ? s.reject(error) : s.resolve(result);
  }
  async message(topic, raw) {
    if (raw.length > 30000) return;
    const p = JSON.parse(raw);
    if (!/^[a-f0-9-]{36}$/.test(p.sid || "")) return;
    const o = this.offerState,
      s = this.joinState;
    if (p.side === "join" && o?.topic === topic && Date.now() < o.expiresAt) {
      if (o.consumed && o.consumed !== p.sid) return;
      const send = (v) =>
        this.network.publish(topic, { ...v, side: "offer", sid: p.sid });
      if (p.type === "hello") {
        let a = o.attempts.get(p.sid);
        if (!a) {
          if (o.attempts.size >= 8) return;
          const login = opaque.server.startLogin({
            serverSetup: o.setup,
            registrationRecord: o.registrationRecord,
            userIdentifier: o.room,
            startLoginRequest: p.request,
          });
          a = { login };
          o.attempts.set(p.sid, a);
        }
        send({ type: "challenge", response: a.login.loginResponse });
      } else if (p.type === "finish") {
        const a = o.attempts.get(p.sid);
        if (!a || a.busy || a.failed) return;
        if (a.answer) return send({ type: "paired", envelope: a.answer });
        a.busy = true;
        try {
          const { sessionKey } = opaque.server.finishLogin({
            serverLoginState: a.login.serverLoginState,
            finishLoginRequest: p.finish,
          });
          const who = validIdentity(
            unwrap(sessionKey, "join:" + p.sid, p.envelope),
          );
          if (who.id === this.identity.id)
            throw Error("Cannot pair device with itself");
          const link = crypto.randomBytes(24).toString("hex"),
            secret = crypto.randomBytes(32).toString("hex");
          await this.accept({ ...who, link, secret });
          a.key = sessionKey;
          a.peerId = who.id;
          a.answer = wrap(sessionKey, "offer:" + p.sid, {
            ...publicIdentity(this.identity),
            link,
            secret,
          });
          o.consumed = p.sid;
          send({ type: "paired", envelope: a.answer });
          this.log("pair_saved", { peerId: who.id });
        } catch (e) {
          a.failed = true;
          throw e;
        } finally {
          a.busy = false;
        }
      } else if (p.type === "receipt") {
        const a = o.attempts.get(p.sid);
        if (
          a?.answer &&
          unwrap(a.key, "receipt:" + p.sid, p.envelope).id === a.peerId
        )
          this.cancelOffer();
      }
    }
    if (p.side === "offer" && s?.topic === topic && p.sid === s.sid) {
      if (p.type === "challenge" && !s.finish) {
        const login = opaque.client.finishLogin({
          clientLoginState: s.start.clientLoginState,
          loginResponse: p.response,
          password: s.password,
        });
        if (!login) return this.endJoin(Error("Pairing authentication failed"));
        s.finish = {
          key: login.sessionKey,
          request: login.finishLoginRequest,
          envelope: wrap(
            login.sessionKey,
            "join:" + s.sid,
            publicIdentity(this.identity),
          ),
        };
        this.sendJoin();
      } else if (p.type === "paired" && s.finish && !s.busy) {
        s.busy = true;
        try {
          const peer = unwrap(s.finish.key, "offer:" + s.sid, p.envelope);
          validIdentity(peer);
          await this.accept(peer);
          this.network.publish(topic, {
            side: "join",
            sid: s.sid,
            type: "receipt",
            envelope: wrap(s.finish.key, "receipt:" + s.sid, {
              id: this.identity.id,
            }),
          });
          this.log("pair_saved", { peerId: peer.id });
          this.endJoin(null, { peerId: peer.id });
        } catch (e) {
          this.endJoin(Error("Pair verification failed"));
          throw e;
        }
      }
    }
  }
  stop() {
    this.cancelOffer();
    this.endJoin(Error("Application stopped"));
    this.network.off("message", this.listener);
  }
}
module.exports = { Pairing, wrap, unwrap };
