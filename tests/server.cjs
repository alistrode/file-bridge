"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto"),
  cp = require("node:child_process");
const ROOT = path.resolve(__dirname, ".."),
  CHUNK = 1024 * 1024,
  hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
async function start(dir) {
  const child = cp.fork(path.join(ROOT, "source/server.js"), [], {
    env: {
      ...process.env,
      FILE_BRIDGE_DATA_DIR: dir,
      PORT: "0",
      HOST: "127.0.0.1",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Server startup timeout " + stderr)),
      10000,
    );
    child.once("message", (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(Error("Server exited " + code + " " + stderr));
    });
  });
  return { child, ...ready, origin: "http://127.0.0.1:" + ready.port };
}
async function stop(s, signal = "SIGTERM") {
  if (s.child.exitCode !== null || s.child.signalCode) return;
  const closed = new Promise((r) => s.child.once("exit", r));
  s.child.kill(signal);
  await closed;
}
function manifest(bytes, name = "roundtrip.bin") {
  const blocks = [];
  for (let i = 0; i < bytes.length; i += CHUNK)
    blocks.push(hash(bytes.subarray(i, i + CHUNK)));
  return {
    id: crypto.randomUUID(),
    size: bytes.length,
    name,
    mime: "application/octet-stream",
    blocks,
    manifest: hash(blocks.join("")),
  };
}
async function api(s, route, opts = {}) {
  const r = await fetch(s.origin + route, {
    method: opts.method || (opts.json ? "POST" : "GET"),
    headers: {
      "x-file-bridge-token": s.token,
      "x-file-bridge-request": "1",
      ...(opts.json ? { "Content-Type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.raw ?? (opts.json ? JSON.stringify(opts.json) : undefined),
  });
  return { status: r.status, headers: r.headers, body: await r.arrayBuffer() };
}
const json = (r) => JSON.parse(Buffer.from(r.body));
test("single-host durable transfers survive interruption without advertising partial files", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-server-"));
  let s = await start(dir);
  t.after(async () => {
    await stop(s);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const bytes = crypto.randomBytes(CHUNK * 2 + 321),
    m = manifest(bytes);
  assert.equal((await fetch(s.origin + "/api/items")).status, 401);
  assert.equal((await api(s, "/api/uploads", { json: m })).status, 200);
  assert.equal(
    (
      await api(s, "/api/uploads/" + m.id + "/chunks/0", {
        method: "PUT",
        raw: bytes.subarray(0, CHUNK),
      })
    ).status,
    200,
  );
  assert.equal(
    (await api(s, "/api/uploads/" + m.id + "/complete", { json: {} })).status,
    409,
  );
  assert.equal(json(await api(s, "/api/items")).items.length, 0);
  assert.equal(
    (
      await api(s, "/api/uploads/" + m.id + "/chunks/1", {
        method: "PUT",
        raw: Buffer.alloc(CHUNK),
      })
    ).status,
    422,
  );
  const token = s.token;
  await stop(s, "SIGKILL");
  s = await start(dir);
  assert.equal(s.token, token);
  let snapshot = json(await api(s, "/api/uploads/" + m.id));
  assert.deepEqual(snapshot.present, [0]);
  fs.writeFileSync(path.join(dir, "uploads", m.id, "0"), Buffer.alloc(CHUNK));
  snapshot = json(await api(s, "/api/uploads/" + m.id));
  assert.deepEqual(
    snapshot.present,
    [],
    "corrupt saved chunks must be retransmitted",
  );
  for (let i = 0; i < m.blocks.length; i++)
    assert.equal(
      (
        await api(s, "/api/uploads/" + m.id + "/chunks/" + i, {
          method: "PUT",
          raw: bytes.subarray(i * CHUNK, (i + 1) * CHUNK),
        })
      ).status,
      200,
    );
  const committed = await api(s, "/api/uploads/" + m.id + "/complete", {
    json: {},
  });
  assert.equal(committed.status, 201);
  const item = json(committed).item;
  assert.equal(item.digest, hash(bytes));
  // Discard the saved response and restart, as when an ACK is lost during shutdown.
  await stop(s, "SIGKILL");
  s = await start(dir);
  assert.equal(
    (await api(s, "/api/uploads/" + m.id + "/complete", { json: {} })).status,
    201,
  );
  const again = json(
    await api(s, "/api/uploads", { json: { ...m, id: crypto.randomUUID() } }),
  );
  assert.equal(
    again.id,
    m.id,
    "same-file reselection after a URL change must reuse saved data",
  );
  assert.equal(again.state, "completed");
  assert.equal(json(await api(s, "/api/items")).items.length, 1);
  const download = await api(s, item.download);
  assert.deepEqual(Buffer.from(download.body), bytes);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);
  const range = await api(s, item.download, {
    headers: { Range: "bytes=17-87" },
  });
  assert.equal(range.status, 206);
  assert.deepEqual(Buffer.from(range.body), bytes.subarray(17, 88));
  const archivedResults = await Promise.all(
    [1, 2, 3].map(() => api(s, "/api/archive/" + item.id, { json: {} })),
  );
  assert(archivedResults.every((r) => r.status === 201));
  assert.equal(
    json(await api(s, "/api/items")).items.find((i) => i.id === item.id)
      .archived,
    true,
  );
  await stop(s);
  s = await start(dir);
  const saved = json(await api(s, "/api/archives")).items;
  assert.equal(saved.length, 1);
  assert.deepEqual(Buffer.from((await api(s, saved[0].download)).body), bytes);
  const text = {
    id: crypto.randomUUID(),
    text: "同一个网址，文字只保存一次。",
  };
  assert.equal((await api(s, "/api/text", { json: text })).status, 201);
  assert.equal((await api(s, "/api/text", { json: text })).status, 201);
  assert.equal(
    json(await api(s, "/api/items")).items.filter((i) => i.id === text.id)
      .length,
    1,
  );
  assert.equal(
    (
      await api(s, "/api/uploads", {
        json: { ...manifest(Buffer.alloc(0), "collision.bin"), id: text.id },
      })
    ).status,
    409,
  );
  const zero = manifest(Buffer.alloc(0), "empty.txt");
  assert.equal((await api(s, "/api/uploads", { json: zero })).status, 200);
  const z = json(
    await api(s, "/api/uploads/" + zero.id + "/complete", { json: {} }),
  );
  assert.equal((await api(s, z.item.download)).body.byteLength, 0);
  assert.equal((await api(s, "/api/pair/create", { json: {} })).status, 404);
  assert.equal((await api(s, "/api/peers")).status, 404);
});

test("independent sources remain distinct for identical files, retries, restarts and archives", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-sources-"));
  let s = await start(dir);
  t.after(async () => { await stop(s); await fsp.rm(dir, { recursive: true, force: true }); });
  const a = { id: crypto.randomUUID(), name: '办公室主机' },
    b = { id: crypto.randomUUID(), name: '办公室主机' }; // Identical names still have different identities.
  const bytes = Buffer.from('same file from two hosts'), base = manifest(bytes);
  const upload = async (source) => {
    const m = { ...base, id: crypto.randomUUID(), source };
    const prepared = json(await api(s, '/api/uploads', { json: m }));
    assert.equal(prepared.id, m.id);
    await api(s, '/api/uploads/' + m.id + '/chunks/0', { method: 'PUT', raw: bytes });
    return json(await api(s, '/api/uploads/' + m.id + '/complete', { json: {} })).item;
  };
  const [ia, ib] = await Promise.all([upload(a), upload(b)]);
  assert.notEqual(ia.id, ib.id);
  assert.deepEqual(ia.source, a); assert.deepEqual(ib.source, b);
  const newOrigin = { ...base, id: crypto.randomUUID(), source: { id: crypto.randomUUID(), name:'换网址后的浏览器' } };
  const resumed = json(await api(s, '/api/uploads', { json: newOrigin }));
  assert.equal(resumed.id, newOrigin.id);
  assert.deepEqual(resumed.present, [0], 'new source after a tunnel URL change reuses verified host chunks without merging source records');

  const retry = json(await api(s, '/api/uploads', { json: { ...base, id: crypto.randomUUID(), source: a } }));
  assert.equal(retry.id, ia.id);
  assert.equal((await api(s, '/api/uploads', { json: { ...base, id: ia.id, source: b } })).status, 409);
  const ta = { id: crypto.randomUUID(), text: 'host text', source: a };
  assert.equal((await api(s, '/api/text', { json: ta })).status, 201);
  assert.equal((await api(s, '/api/text', { json: { ...ta, source: b } })).status, 409);
  assert.equal((await api(s, '/api/text', { json: { ...ta, id: crypto.randomUUID(), source: { id: 'bad', name: 'x' } } })).status, 400);
  for (const bad of [{id:a.id,name:'x'.repeat(41)},{id:a.id,name:'bad\nname'}])
    assert.equal((await api(s, '/api/text', { json: { id:crypto.randomUUID(),text:'invalid',source:bad } })).status,400);
  await api(s, '/api/archive/' + ia.id, { json: {} });
  await stop(s, 'SIGKILL'); s = await start(dir);
  const archiveResponse = json(await api(s, '/api/archives'));
  assert.deepEqual(archiveResponse.items[0].source, a);
  assert.deepEqual(archiveResponse.sources.map(x=>x.id).sort(),[a.id,b.id].sort());
  const items = json(await api(s, '/api/items')).items;
  assert.equal(items.filter(i => i.source?.id === a.id).length, 2);
  assert.equal(items.filter(i => i.source?.id === b.id).length, 1);
  assert.deepEqual(Buffer.from((await api(s, ib.download)).body), bytes);
});
