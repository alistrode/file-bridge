"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  { EventEmitter } = require("node:events");
const {
  directory,
  load,
  save,
  retryDelay,
  identity,
  seal,
  unseal,
  logger,
} = require("../source/bridge/state.cjs");
const {
  linuxEntry,
  windowsStartupScript,
  profileId,
  launchBrowser,
  applyStartup,
  startupPath,
} = require("../source/bridge/platform.cjs");
const { Bridge, digest } = require("../source/bridge/engine.cjs");
const { App } = require("../source/bridge/app.cjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "fb-unit-"));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await fn()) return;
    await wait(30);
  }
  throw Error("Test condition timed out");
}
class Bus {
  constructor() {
    this.members = new Set();
    this.drop = () => false;
  }
  factory = () => {
    const bus = this;
    const n = new EventEmitter();
    n.online = false;
    n.topics = new Set();
    n.subscribe = (t) => n.topics.add(t);
    n.unsubscribe = (t) => n.topics.delete(t);
    n.start = () => {
      bus.members.add(n);
      n.online = true;
      n.emit("online");
    };
    n.stop = () => {
      bus.members.delete(n);
      n.online = false;
      n.emit("offline");
    };
    n.publish = (t, d) => {
      if (!n.online) return false;
      if (bus.drop(t, d)) return true;
      for (const member of bus.members)
        if (member.topics.has(t))
          queueMicrotask(() =>
            member.emit(
              "message",
              t,
              typeof d === "string" ? d : JSON.stringify(d),
            ),
          );
      return true;
    };
    return n;
  };
}
test("linear retry increments one second, including after 60 attempts", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 60, 61].map(retryDelay),
    [1000, 2000, 3000, 4000, 60000, 61000],
  );
  assert.throws(() => retryDelay(0));
});
test("private persisted identity, directional authenticated encryption and pinned signature", () => {
  const r = temp();
  try {
    const a = identity(directory(path.join(r, "a"))),
      b = identity(directory(path.join(r, "b"))),
      s = crypto.randomBytes(32).toString("hex");
    assert.equal(identity(path.join(r, "a")).id, a.id);
    const wire = seal(s, a.id, b.id, { value: "测试" }, a.privateKey);
    assert.deepEqual(unseal(s, a.id, b.id, wire, a.publicKey), {
      value: "测试",
    });
    assert.throws(() => unseal(s, b.id, a.id, wire, a.publicKey));
    assert.throws(() => unseal(s, a.id, b.id, wire, b.publicKey));
    const v = JSON.parse(wire);
    v.body = v.body.replace('"v":2', '"v":1');
    assert.throws(() => unseal(s, a.id, b.id, JSON.stringify(v), a.publicKey));
    if (process.platform !== "win32")
      assert.equal(
        fs.statSync(path.join(r, "a/identity.json")).mode & 0o777,
        0o600,
      );
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("logs rotate and redact sensitive fields without storing payload", () => {
  const r = temp();
  try {
    const log = logger(r);
    log("check", {
      token: "DO_NOT_LOG",
      privateKey: "PRIVATE",
      code: "PAIR",
      secret: "MASTER",
      text: "MESSAGE",
      reason: "timeout",
    });
    const s = fs.readFileSync(path.join(r, "events.jsonl"), "utf8");
    for (const v of ["DO_NOT_LOG", "PRIVATE", "PAIR", "MASTER", "MESSAGE"])
      assert(!s.includes(v));
    assert(s.includes("timeout"));
    fs.writeFileSync(path.join(r, "events.jsonl"), "x".repeat(2 * 1024 * 1024));
    log("rotated");
    assert(fs.existsSync(path.join(r, "events.jsonl.1")));
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("Windows and Linux startup names are profile-specific; no shell URL execution", () => {
  const a = {
      executable: "C:\\Program Files\\File Bridge\\electron.exe",
      appRoot: "C:\\file bridge",
      profile: "C:\\profiles\\one",
    },
    b = { ...a, profile: "C:\\profiles\\two" };
  assert.notEqual(profileId(a.profile), profileId(b.profile));
  assert.match(
    windowsStartupScript({
      ...a,
      target: "C:\\startup\\fb.lnk",
      enabled: true,
    }),
    /CreateShortcut/,
  );
  assert.match(linuxEntry(a), /--startup/);
  assert.throws(() => launchBrowser("https://example.com"));
  let call;
  launchBrowser("http://127.0.0.1:12345/?token=abc", {
    platform: "win32",
    spawn: (...args) => (call = args),
  });
  assert.equal(call[0], "powershell.exe");
  const decoded = Buffer.from(call[1].at(-1), "base64").toString("utf16le");
  assert(decoded.startsWith("Start-Process -FilePath "));
  assert(!decoded.includes("cmd.exe"));
  const r = temp();
  try {
    const p = path.join(r, "profile"),
      env = { XDG_CONFIG_HOME: path.join(r, "config") },
      o = {
        executable: "/path with spaces/electron",
        appRoot: "/app",
        profile: p,
      };
    assert.equal(
      applyStartup(o, true, { platform: "linux", env }).registered,
      true,
    );
    assert(fs.existsSync(startupPath(p, "linux", env)));
    applyStartup(o, false, { platform: "linux", env });
    assert(!fs.existsSync(startupPath(p, "linux", env)));
  } finally {
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("OPAQUE one-code pairing is symmetric and remembers identities; durable ACK handles lost acknowledgement and restart", async () => {
  const r = temp(),
    bus = new Bus();
  let a = new Bridge({
      profile: path.join(r, "a"),
      networkFactory: bus.factory,
    }),
    b = new Bridge({ profile: path.join(r, "b"), networkFactory: bus.factory });
  try {
    a.start();
    b.start();
    const code = await b.pairing.offer();
    await a.pairing.join(code.code);
    await until(() => a.online(b.identity.id) && b.online(a.identity.id));
    const aid = a.identity.id,
      bid = b.identity.id;
    assert.equal(a.peers[bid].publicKey, b.identity.publicKey);
    assert.equal(b.peers[aid].publicKey, a.identity.publicKey);
    let dropped = false;
    bus.drop = (t, d) => {
      if (t === a.topic(a.peers[bid], bid) && !dropped) {
        const p = unseal(
          a.peers[bid].secret,
          bid,
          aid,
          d,
          b.identity.publicKey,
        );
        if (p.kind === "ack") {
          dropped = true;
          return true;
        }
      }
      return false;
    };
    const j = a.enqueue(bid, "text", { text: "deduplicated" });
    await until(() => a.jobs.find((x) => x.id === j.id).state === "delivered");
    assert(dropped);
    assert.equal(b.items.filter((x) => x.id === j.id).length, 1);
    bus.drop = () => false;
    const data = crypto.randomBytes(100000),
      file = path.join(r, "upload");
    fs.writeFileSync(file, data);
    await a.stop();
    a = new Bridge({ profile: path.join(r, "a"), networkFactory: bus.factory });
    a.start();
    await until(() => a.online(bid));
    const f = a.enqueue(bid, "file", {
      temp: file,
      name: "../测试.bin",
      size: data.length,
      digest: await digest(file),
    });
    await until(() => b.items.some((x) => x.id === f.id));
    await until(() => a.jobs.find((x) => x.id === f.id).state === "delivered");
    const item = b.items.find((x) => x.id === f.id);
    assert.deepEqual(fs.readFileSync(b.file(item.file)), data);
    assert.equal(item.name, "测试.bin");
    const reply = b.enqueue(aid, "open");
    await until(() => a.items.some((x) => x.id === reply.id));
    assert.equal(a.items.find((x) => x.id === reply.id).status, "pending");
    await b.stop();
    b = new Bridge({ profile: path.join(r, "b"), networkFactory: bus.factory });
    b.start();
    await until(() => a.online(bid) && b.online(aid));
    assert(b.items.some((x) => x.id === f.id));
    a.revoke(bid);
    assert.throws(() => a.enqueue(bid, "text", { text: "blocked" }));
  } finally {
    await a.stop();
    await b.stop();
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("dashboard enforces local Host, token, origin, CSRF header and instance lock", async () => {
  const r = temp();
  const app = await new App({
    profile: r,
    networkFactory: new Bus().factory,
  }).start();
  try {
    assert.equal((await fetch(app.origin + "/api/status")).status, 401);
    assert.equal((await fetch(app.url)).status, 200);
    assert.equal(
      (
        await fetch(app.origin + "/api/status", {
          headers: {
            "x-file-bridge-token": app.token,
            Origin: "https://evil.example",
          },
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/pair/cancel", {
          method: "POST",
          headers: { "x-file-bridge-token": app.token },
        })
      ).status,
      403,
    );
    await assert.rejects(
      () => new App({ profile: r }).start(),
      /already running/,
    );
    assert.equal(
      (
        await fetch(app.origin + "/api/status", {
          headers: { "x-file-bridge-token": app.token },
        })
      ).status,
      200,
    );
  } finally {
    await app.stop();
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("file checkpoint resumes after receiver restarts during transfer", async () => {
  const r = temp(),
    bus = new Bus();
  let a = new Bridge({
      profile: path.join(r, "a"),
      networkFactory: bus.factory,
    }),
    b = new Bridge({ profile: path.join(r, "b"), networkFactory: bus.factory });
  try {
    a.start();
    b.start();
    const code = await b.pairing.offer();
    await a.pairing.join(code.code);
    const aid = a.identity.id,
      bid = b.identity.id;
    await until(() => a.online(bid) && b.online(aid));
    let hold = true;
    bus.drop = (t, d) => {
      if (t !== b.topic(b.peers[aid], aid)) return false;
      const p = unseal(b.peers[aid].secret, aid, bid, d, a.identity.publicKey);
      return hold && p.kind === "job" && p.type === "file" && p.index >= 1;
    };
    const payload = crypto.randomBytes(200000),
      file = path.join(r, "resume.bin");
    fs.writeFileSync(file, payload);
    const task = a.enqueue(bid, "file", {
      temp: file,
      name: "resume.bin",
      size: payload.length,
      digest: await digest(file),
    });
    await until(() => a.jobs.find((x) => x.id === task.id).next === 1);
    await b.stop();
    b = new Bridge({ profile: path.join(r, "b"), networkFactory: bus.factory });
    hold = false;
    b.start();
    await until(
      () => a.jobs.find((x) => x.id === task.id).state === "delivered",
    );
    const item = b.items.find((x) => x.id === task.id);
    assert.deepEqual(fs.readFileSync(b.file(item.file)), payload);
    assert.equal(b.items.filter((x) => x.id === task.id).length, 1);
  } finally {
    await a.stop();
    await b.stop();
    fs.rmSync(r, { recursive: true, force: true });
  }
});
test("desktop dispatch persists acceptance and consumes one local open event, without OS browser fallback", async () => {
  const root = temp(),
    bus = new Bus();
  let launched = 0;
  const app = await new App({
    profile: root,
    networkFactory: bus.factory,
    openBrowser: () => {
      launched++;
      return null;
    },
  }).start();
  const post = async (route, value = {}) => {
    const r = await fetch(app.origin + route, {
      method: "POST",
      headers: {
        "x-file-bridge-token": app.token,
        "x-file-bridge-request": "1",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    await post("/api/desktop/poll");
    const id = crypto.randomUUID();
    app.bridge.items.unshift({
      id,
      peerId: crypto.randomUUID(),
      type: "open",
      status: "pending",
      createdAt: Date.now(),
    });
    const accepted = await app.acceptOpen(id);
    assert.equal(accepted.queuedForDesktop, true);
    assert.equal(launched, 0);
    assert.deepEqual((await post("/api/desktop/poll")).requestIds, [id]);
    assert.deepEqual((await post("/api/desktop/poll")).requestIds, []);
    assert.equal(load(path.join(root, "items.json"))[0].status, "accepted");
    app.bridge.items[0].pendingDesktopOpen = true;
    app.bridge.items[0].createdAt = Date.now() - 360000;
    assert.deepEqual((await post("/api/desktop/poll")).requestIds, []);
    assert.equal(app.bridge.items[0].pendingDesktopOpen, false);
  } finally {
    await app.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
