"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  { EventEmitter } = require("node:events");
const {
  directory,
  load,
  save,
  identity,
  validIdentity,
  seal,
  unseal,
  logger,
  retryDelay,
} = require("./state.cjs");
const { Network, PREFIX } = require("./network.cjs");
const { Pairing } = require("./pairing.cjs");
const CHUNK = 32768,
  MAX_FILE = 1073741824,
  uuid = (s) => typeof s === "string" && /^[a-f0-9-]{36}$/.test(s);
const cleanName = (s) =>
  path
    .basename(String(s))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 180) || "file.bin";
async function digest(file) {
  const h = crypto.createHash("sha256");
  for await (const b of fs.createReadStream(file)) h.update(b);
  return h.digest("hex");
}
class Bridge extends EventEmitter {
  constructor({
    profile,
    broker,
    networkFactory = (options) => new Network(options),
  }) {
    super();
    this.profile = path.resolve(profile);
    directory(this.profile);
    this.log = logger(path.join(this.profile, "logs"));
    this.identity = identity(this.profile);
    this.settings = load(this.file("settings.json"), {
      openOnStartup: false,
      loginStartup: false,
    });
    this.peers = load(this.file("peers.json"), {});
    this.jobs = load(this.file("jobs.json"), []);
    this.items = load(this.file("items.json"), []);
    this.lastSeen = new Map();
    this.pings = new Map();
    this.sent = new Map();
    this.live = new Set();
    this.chain = Promise.resolve();
    this.network = networkFactory({
      broker,
      id: this.identity.id,
      log: this.log,
    });
    this.pairing = new Pairing({
      network: this.network,
      identity: this.identity,
      accept: (p) => this.accept(p),
      log: this.log,
    });
    this.network.on("message", (t, d) => {
      if (!t.startsWith(PREFIX + "/link/")) return;
      this.chain = this.chain
        .then(() => this.receive(t, d))
        .catch((e) =>
          this.log("incoming_rejected", {
            reason: e.code || e.name,
            frames: String(e.stack || "")
              .split("\n")
              .slice(1, 5)
              .map((x) => x.replace(this.profile, "[profile]")),
          }),
        );
    });
    this.network.on("offline", () => {
      this.lastSeen.clear();
      this.pings.clear();
      this.sent.clear();
      for (const id of this.live) this.log("peer_disconnected", { peerId: id });
      this.live.clear();
    });
    this.network.on("online", () => {
      this.lastPing = 0;
      this.sent.clear();
    });
    this.stopped = true;
  }
  file(p) {
    return path.join(this.profile, p);
  }
  topic(p, sender) {
    return PREFIX + "/link/" + p.link + "/" + sender;
  }
  async accept(p) {
    validIdentity(p);
    if (
      p.id === this.identity.id ||
      !/^[a-f0-9]{48}$/.test(p.link) ||
      !/^[a-f0-9]{64}$/.test(p.secret)
    )
      throw Error("Invalid paired peer");
    const old = this.peers[p.id];
    if (old && old.publicKey !== p.publicKey)
      throw Error("Paired identity changed; revoke explicitly before pairing");
    if (old) this.network.unsubscribe(this.topic(old, p.id));
    this.peers[p.id] = {
      id: p.id,
      label: p.label,
      publicKey: p.publicKey,
      link: p.link,
      secret: p.secret,
      pairedAt: Date.now(),
      enabled: true,
    };
    save(this.file("peers.json"), this.peers);
    this.network.subscribe(this.topic(p, p.id));
    this.lastPing = 0;
  }
  start() {
    if (!this.stopped) return;
    this.stopped = false;
    for (const p of Object.values(this.peers))
      if (p.enabled) this.network.subscribe(this.topic(p, p.id));
    this.network.start();
    this.timer = setInterval(() => this.tick(), 250);
    this.log("bridge_started", { deviceId: this.identity.id });
  }
  send(peer, packet) {
    if (!peer.enabled) return false;
    return this.network.publish(
      this.topic(peer, this.identity.id),
      seal(
        peer.secret,
        this.identity.id,
        peer.id,
        { ...packet, time: Date.now() },
        this.identity.privateKey,
      ),
    );
  }
  online(id) {
    return (
      this.network.online && Date.now() - (this.lastSeen.get(id) || 0) < 20000
    );
  }
  markSeen(id) {
    this.lastSeen.set(id, Date.now());
    if (!this.live.has(id)) {
      this.live.add(id);
      this.log("peer_connected", { peerId: id });
    }
  }
  tick() {
    if (this.stopped || !this.network.online) return;
    const now = Date.now();
    if (!this.lastPing || now - this.lastPing >= 5000) {
      this.lastPing = now;
      for (const p of Object.values(this.peers)) {
        if (!p.enabled) continue;
        let entries = this.pings.get(p.id) || [];
        entries = entries.filter((x) => now - x.time < 20000);
        const ping = { nonce: crypto.randomUUID(), time: now };
        entries.push(ping);
        this.pings.set(p.id, entries);
        this.send(p, { kind: "ping", nonce: ping.nonce });
        if (this.live.has(p.id) && !this.online(p.id)) {
          this.live.delete(p.id);
          this.log("peer_disconnected", { peerId: p.id });
        }
      }
    }
    for (const p of Object.values(this.peers)) {
      if (!p.enabled || !this.online(p.id)) continue;
      const job = this.jobs.find(
        (j) => j.peerId === p.id && j.state === "queued",
      );
      if (!job) continue;
      const sent = this.sent.get(job.id);
      if (sent && now < sent.nextAt) continue;
      const failures = sent ? sent.failures + 1 : 0;
      try {
        const packet = this.packet(job);
        if (this.send(p, packet)) {
          this.sent.set(job.id, {
            index: job.next,
            failures,
            nextAt: now + retryDelay(failures + 1),
          });
          if (failures)
            this.log("delivery_retry", {
              peerId: p.id,
              jobId: job.id,
              attempt: failures,
              delayMs: retryDelay(failures + 1),
            });
        }
      } catch (e) {
        job.state = "failed";
        job.error = "Unable to read queued payload";
        save(this.file("jobs.json"), this.jobs);
        this.log("job_failed", {
          jobId: job.id,
          reason: e.code || "payload_error",
        });
      }
    }
  }
  packet(j) {
    const packet = {
      kind: "job",
      jobId: j.id,
      index: j.next,
      total: j.total,
      type: j.type,
      createdAt: j.createdAt,
    };
    if (j.type === "file") {
      const size = Math.min(CHUNK, j.size - j.next * CHUNK),
        b = Buffer.alloc(Math.max(0, size)),
        fd = fs.openSync(this.file("outbox/" + j.id + ".bin"), "r");
      try {
        if (fs.readSync(fd, b, 0, b.length, j.next * CHUNK) !== b.length)
          throw Error("Queued file truncated");
      } finally {
        fs.closeSync(fd);
      }
      Object.assign(packet, {
        name: j.name,
        size: j.size,
        digest: j.digest,
        mime: j.mime,
        data: b.toString("base64"),
      });
    } else if (j.type === "text") packet.text = j.text;
    return packet;
  }
  async receive(topic, wire) {
    const peer = Object.values(this.peers).find(
      (p) => p.enabled && this.topic(p, p.id) === topic,
    );
    if (!peer) return;
    const p = unseal(
      peer.secret,
      peer.id,
      this.identity.id,
      wire,
      peer.publicKey,
    );
    if (!Number.isFinite(p.time) || Math.abs(Date.now() - p.time) > 120000)
      throw Error("Expired or clock-skewed frame");
    if (p.kind === "ping") {
      if (!uuid(p.nonce)) return;
      this.send(peer, { kind: "pong", nonce: p.nonce });
      return;
    }
    if (p.kind === "pong") {
      const pending = this.pings.get(peer.id) || [];
      if (pending.some((x) => x.nonce === p.nonce)) {
        this.pings.set(
          peer.id,
          pending.filter((x) => x.nonce !== p.nonce),
        );
        this.markSeen(peer.id);
      }
      return;
    }
    if (p.kind === "ack") {
      const j = this.jobs.find(
        (x) => x.id === p.jobId && x.peerId === peer.id && x.state === "queued",
      );
      if (!j) return;
      if (p.error) {
        j.state = "failed";
        j.error = "Peer rejected transfer";
        this.log("job_failed", { jobId: j.id, reason: "peer_rejected" });
      } else {
        if (!Number.isSafeInteger(p.next) || p.next < 0 || p.next > j.total)
          return;
        const sent = this.sent.get(j.id);
        if (!sent || p.next !== sent.index + 1) return;
        j.next = p.next;
        if (j.next === j.total) {
          j.state = "delivered";
          j.deliveredAt = Date.now();
          this.log("job_delivered", {
            jobId: j.id,
            peerId: peer.id,
            type: j.type,
          });
          if (j.type === "file")
            fs.rmSync(this.file("outbox/" + j.id + ".bin"), { force: true });
        }
        this.markSeen(peer.id);
      }
      save(this.file("jobs.json"), this.jobs);
      this.sent.delete(j.id);
      return;
    }
    if (p.kind !== "job") return;
    if (
      !uuid(p.jobId) ||
      !Number.isSafeInteger(p.index) ||
      !Number.isSafeInteger(p.total) ||
      p.index < 0 ||
      p.total < 1 ||
      p.total > 32768 ||
      p.index >= p.total ||
      !["text", "file", "open"].includes(p.type)
    )
      throw Error("Invalid delivery metadata");
    const ack = (next, error) =>
      this.send(peer, {
        kind: "ack",
        jobId: p.jobId,
        next,
        ...(error ? { error: true } : {}),
      });
    const metaFile = this.file("inbox/" + peer.id + "/" + p.jobId + ".json");
    let meta = load(metaFile, null);
    if (meta?.complete) {
      ack(p.index + 1);
      return;
    }
    if (
      !Number.isFinite(p.createdAt) ||
      p.createdAt > Date.now() + 120000 ||
      Date.now() - p.createdAt > (p.type === "open" ? 300000 : 7 * 86400000)
    ) {
      ack(0, true);
      return;
    }
    if (p.type !== "file") {
      if (p.index !== 0 || p.total !== 1) return ack(0, true);
      if (
        p.type === "text" &&
        (typeof p.text !== "string" || Buffer.byteLength(p.text) > 65536)
      )
        return ack(0, true);
      const exists = this.items.some(
        (x) => x.id === p.jobId && x.peerId === peer.id,
      );
      if (!exists) {
        const item = {
          id: p.jobId,
          peerId: peer.id,
          label: peer.label,
          type: p.type,
          createdAt: Date.now(),
          ...(p.type === "text" ? { text: p.text } : { status: "pending" }),
        };
        this.items.unshift(item);
        save(this.file("items.json"), this.items);
        this.log("job_received", {
          peerId: peer.id,
          jobId: p.jobId,
          type: p.type,
        });
        this.emit("item", item);
      }
      save(metaFile, { complete: true });
      ack(1);
      return;
    }
    if (
      !Number.isSafeInteger(p.size) ||
      p.size < 0 ||
      p.size > MAX_FILE ||
      Math.max(1, Math.ceil(p.size / CHUNK)) !== p.total ||
      !/^[a-f0-9]{64}$/.test(p.digest) ||
      typeof p.name !== "string" ||
      typeof p.data !== "string" ||
      p.data.length > CHUNK * 2
    )
      return ack(0, true);
    if (!meta) {
      if (p.index !== 0) return ack(0);
      meta = {
        next: 0,
        size: p.size,
        digest: p.digest,
        total: p.total,
        name: cleanName(p.name),
        mime: String(p.mime || "application/octet-stream").slice(0, 100),
      };
    }
    if (
      meta.digest !== p.digest ||
      meta.size !== p.size ||
      meta.total !== p.total
    )
      return ack(0, true);
    if (p.index < meta.next) {
      if (meta.next === meta.total) {
        await this.finishFile(peer, p.jobId, meta, metaFile);
        ack(p.index + 1);
      } else ack(p.index + 1);
      return;
    }
    if (p.index !== meta.next) return ack(meta.next);
    const chunk = Buffer.from(p.data, "base64"),
      expected = Math.min(CHUNK, p.size - p.index * CHUNK);
    if (chunk.length !== expected) return ack(0, true);
    const staged = this.file("incoming/" + peer.id + "/" + p.jobId + ".part");
    directory(path.dirname(staged));
    const fd = fs.openSync(staged, fs.existsSync(staged) ? "r+" : "w", 0o600);
    try {
      fs.writeSync(fd, chunk, 0, chunk.length, p.index * CHUNK);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    meta.next++;
    save(metaFile, meta);
    if (meta.next === meta.total) {
      try {
        await this.finishFile(peer, p.jobId, meta, metaFile);
      } catch (e) {
        ack(0, true);
        throw e;
      }
    }
    ack(p.index + 1);
  }
  async finishFile(peer, id, meta, metaFile) {
    const staged = this.file("incoming/" + peer.id + "/" + id + ".part"),
      dest = this.file("received/" + peer.id + "/" + id + "-" + meta.name);
    directory(path.dirname(dest));
    const actual = fs.existsSync(staged) ? staged : dest;
    if ((await digest(actual)) !== meta.digest) {
      fs.rmSync(staged, { force: true });
      fs.rmSync(metaFile, { force: true });
      throw Error("Received file digest mismatch");
    }
    if (actual === staged) fs.renameSync(staged, dest);
    if (!this.items.some((i) => i.id === id && i.peerId === peer.id)) {
      const item = {
        id,
        peerId: peer.id,
        label: peer.label,
        type: "file",
        name: meta.name,
        size: meta.size,
        digest: meta.digest,
        file: path.relative(this.profile, dest),
        createdAt: Date.now(),
      };
      this.items.unshift(item);
      save(this.file("items.json"), this.items);
      this.log("job_received", { peerId: peer.id, jobId: id, type: "file" });
      this.emit("item", item);
    }
    meta.complete = true;
    save(metaFile, meta);
  }
  enqueue(peerId, type, value = {}) {
    if (!this.peers[peerId]?.enabled) throw Error("Unknown or disabled peer");
    if (!["text", "file", "open"].includes(type))
      throw Error("Unsupported operation");
    if (
      type === "text" &&
      (typeof value.text !== "string" ||
        !value.text.trim() ||
        Buffer.byteLength(value.text) > 65536)
    )
      throw Error("Text must be 1 byte to 64 KiB");
    const j = {
      id: crypto.randomUUID(),
      peerId,
      type,
      state: "queued",
      next: 0,
      total: 1,
      createdAt: Date.now(),
      ...(type === "text" ? { text: value.text } : {}),
    };
    if (type === "file") {
      if (
        !Number.isSafeInteger(value.size) ||
        value.size < 0 ||
        value.size > MAX_FILE ||
        !/^[a-f0-9]{64}$/.test(value.digest)
      )
        throw Error("Invalid file");
      directory(this.file("outbox"));
      fs.renameSync(value.temp, this.file("outbox/" + j.id + ".bin"));
      Object.assign(j, {
        name: cleanName(value.name),
        size: value.size,
        digest: value.digest,
        mime: value.mime || "application/octet-stream",
        total: Math.max(1, Math.ceil(value.size / CHUNK)),
      });
    }
    this.jobs.push(j);
    try {
      save(this.file("jobs.json"), this.jobs);
    } catch (e) {
      this.jobs.pop();
      throw e;
    }
    this.log("job_queued", { peerId, jobId: j.id, type });
    return { id: j.id };
  }
  revoke(peerId) {
    const p = this.peers[peerId];
    if (!p) throw Error("Unknown peer");
    this.network.unsubscribe(this.topic(p, p.id));
    delete this.peers[peerId];
    save(this.file("peers.json"), this.peers);
    for (const j of this.jobs)
      if (j.peerId === peerId && j.state === "queued") {
        j.state = "cancelled";
        this.sent.delete(j.id);
      }
    save(this.file("jobs.json"), this.jobs);
    this.lastSeen.delete(peerId);
    this.log("peer_revoked", { peerId });
  }
  status() {
    return {
      identity: { id: this.identity.id, label: this.identity.label },
      brokerOnline: this.network.online,
      retryAttempt: this.network.failures,
      settings: this.settings,
      peers: Object.values(this.peers).map((p) => ({
        id: p.id,
        label: p.label,
        enabled: p.enabled,
        allowRemoteOpen: !!p.allowRemoteOpen,
        online: this.online(p.id),
        lastSeen: this.lastSeen.get(p.id) || null,
        fingerprint: crypto
          .createHash("sha256")
          .update(p.publicKey)
          .digest("hex"),
      })),
      jobs: this.jobs.slice(-100).map(({ text, ...j }) => j),
      items: this.items.slice(0, 30),
    };
  }
  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    this.pairing.stop();
    this.network.stop();
    await this.chain;
    this.log("bridge_stopped");
  }
}
module.exports = { Bridge, CHUNK, MAX_FILE, digest, cleanName };
