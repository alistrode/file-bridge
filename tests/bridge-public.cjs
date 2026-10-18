"use strict";
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const { App } = require("../source/bridge/app.cjs");
const { digest } = require("../source/bridge/engine.cjs");
const root = path.resolve(
    process.env.FB_TEST_ROOT ||
      fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-public-")),
  ),
  broker =
    process.env.FB_TEST_BROKER === "dual"
      ? undefined
      : process.env.FB_TEST_BROKER || "wss://test.mosquitto.org:8081/mqtt",
  checks = [],
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let a, b;
const record = (name, details = {}) => {
  checks.push({
    name,
    passed: true,
    time: new Date().toISOString(),
    ...details,
  });
  fs.writeFileSync(
    path.join(root, "results.json"),
    JSON.stringify({ broker, checks }, null, 2),
  );
  console.log(JSON.stringify(checks.at(-1)));
};
async function until(fn, label, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(250);
  }
  throw Error("Timed out: " + label);
}
(async () => {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    a = await new App({ profile: path.join(root, "a"), broker }).start();
    b = await new App({ profile: path.join(root, "b"), broker }).start();
    assert.notEqual(a.origin, b.origin);
    await until(
      () => a.bridge.network.online && b.bridge.network.online,
      "public WSS connectivity",
    );
    record("independent dynamic listeners and public WSS connectivity");
    const offer = await b.bridge.pairing.offer();
    await a.bridge.pairing.join(offer.code);
    const aid = a.bridge.identity.id,
      bid = b.bridge.identity.id;
    await until(
      () => a.bridge.online(bid) && b.bridge.online(aid),
      "mutual paired heartbeat",
    );
    record("public OPAQUE pairing and reciprocal remembered device identity");
    const textA = a.bridge.enqueue(bid, "text", { text: "公网双向文字 A→B" }),
      textB = b.bridge.enqueue(aid, "text", { text: "公网双向文字 B→A" });
    await until(
      () =>
        a.bridge.jobs.find((j) => j.id === textA.id).state === "delivered" &&
        b.bridge.jobs.find((j) => j.id === textB.id).state === "delivered",
      "bidirectional text ACK",
    );
    record("public bidirectional UTF-8 text delivery confirmed by receiver");
    const bytes = crypto.randomBytes(128 * 1024),
      file = path.join(root, "test.bin");
    fs.writeFileSync(file, bytes);
    const hash = await digest(file),
      sent = a.bridge.enqueue(bid, "file", {
        temp: file,
        name: "测试-public.bin",
        size: bytes.length,
        digest: hash,
      });
    await until(
      () => a.bridge.jobs.find((j) => j.id === sent.id).state === "delivered",
      "file transfer",
    );
    const received = b.bridge.items.find((i) => i.id === sent.id);
    assert.deepEqual(fs.readFileSync(b.bridge.file(received.file)), bytes);
    record("128 KiB public encrypted file transfer verified byte for byte");
    let opens = 0;
    b.openBrowser = () => {
      opens++;
      return null;
    };
    const request = a.bridge.enqueue(bid, "open");
    await until(
      () => b.bridge.items.some((i) => i.id === request.id),
      "open request",
    );
    assert.equal(opens, 0);
    await b.acceptOpen(request.id);
    assert.equal(opens, 1);
    await assert.rejects(() => b.acceptOpen(request.id));
    record("paired browser request requires consent and executes at most once");
    const beforeIdentity = b.bridge.identity.publicKey;
    await b.stop();
    const queued = a.bridge.enqueue(bid, "text", {
      text: "offline durable queue",
    });
    await sleep(3000);
    assert.equal(a.bridge.jobs.find((j) => j.id === queued.id).state, "queued");
    b = await new App({ profile: path.join(root, "b"), broker }).start();
    assert.equal(b.bridge.identity.publicKey, beforeIdentity);
    await until(
      () => a.bridge.jobs.find((j) => j.id === queued.id).state === "delivered",
      "saved peer automatic recovery after receiver restart",
    );
    assert.equal(b.bridge.items.filter((i) => i.id === queued.id).length, 1);
    record(
      "receiver restart and offline durable queue recover without new pairing",
    );
    if (a.bridge.network.endpoints.length > 1) {
      a.bridge.network.endpoints[0].client.stream.destroy();
      await sleep(500);
      assert(a.bridge.network.online);
      const failover = b.bridge.enqueue(aid, "text", {
        text: "surviving independent broker",
      });
      await until(
        () =>
          b.bridge.jobs.find((j) => j.id === failover.id).state === "delivered",
        "dual broker failover",
      );
      record(
        "one broker failure preserves delivery on independent second broker",
      );
    }
    for (const endpoint of a.bridge.network.endpoints)
      endpoint.client.stream.destroy();
    await until(() => !a.bridge.network.online, "network failure detection");
    await until(
      () => a.bridge.online(bid) && b.bridge.online(aid),
      "automatic reconnect after forced socket failure",
    );
    record("real WSS socket failure automatically reconnects same pinned peer");
    const oldId = a.bridge.identity.id;
    await a.stop();
    a = await new App({ profile: path.join(root, "a"), broker }).start();
    assert.equal(a.bridge.identity.id, oldId);
    await until(
      () => a.bridge.online(bid) && b.bridge.online(aid),
      "sender process restart",
    );
    record("sender restart remembers peer and automatically reconnects");
    const duration = Number(process.env.FB_SOAK_SECONDS || 60),
      end = Date.now() + duration * 1000;
    let cycles = 0;
    while (Date.now() < end) {
      const j = a.bridge.enqueue(bid, "text", { text: "soak " + cycles });
      await until(
        () => a.bridge.jobs.find((x) => x.id === j.id).state === "delivered",
        "soak delivery",
        30000,
      );
      cycles++;
      await sleep(5000);
    }
    record("public continuous delivery soak", { seconds: duration, cycles });
    const result = {
      passed: true,
      platform: process.platform,
      node: process.version,
      broker,
      checks,
      limitations: [
        "Windows native tray and system login are separately validated",
        "Broker remains an external dependency",
      ],
    };
    fs.writeFileSync(
      path.join(root, "results.json"),
      JSON.stringify(result, null, 2),
    );
    console.log("RESULTS " + path.join(root, "results.json"));
  } finally {
    await a?.stop();
    await b?.stop();
  }
})().catch((e) => {
  console.error(e);
  fs.writeFileSync(
    path.join(root, "failure.json"),
    JSON.stringify({ error: e.message, checks }, null, 2),
  );
  process.exitCode = 1;
});
