"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process"),
  net = require("node:net");
const { save } = require("../source/host/storage.cjs"),
  { ensure, request } = require("../source/host/cli.cjs"),
  { applyStartup } = require("../source/host/startup.cjs");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await wait(150);
  }
  throw Error("Recovery timed out");
}
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
test("owned website crash is recovered, host startup is exclusive, explicit stop stays stopped", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-host-"));
  save(path.join(dir, "config.json"), { port: 0, tunnel: { mode: "off" } });
  t.after(async () => {
    try {
      await request(dir, "/stop", true);
    } catch {}
    await wait(250);
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const first = await ensure(dir),
    repeat = await ensure(dir);
  assert.equal(first.pid, repeat.pid);
  const token = fs.readFileSync(path.join(dir, "site/token.txt"), "utf8");
  process.kill(first.webPid, "SIGKILL");
  const recovered = await until(async () => {
    const s = await request(dir, "/status");
    return s.webState === "online" && s.webPid !== first.webPid && s;
  });
  assert.equal(recovered.pid, first.pid);
  assert.equal(
    fs.readFileSync(path.join(dir, "site/token.txt"), "utf8"),
    token,
  );
  assert.equal((await fetch(recovered.origin + "/health")).status, 200);
  const entries = fs
    .readFileSync(path.join(dir, "logs/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(entries.some((e) => e.event === "web_retry" && e.delayMs === 1000));
  await request(dir, "/stop", true);
  await until(() => !fs.existsSync(path.join(dir, "host.lock")));
  await wait(1400);
  assert.equal(fs.existsSync(path.join(dir, "host.lock")), false);
});
test(
  "tunnel process crash changes the current entry and automatically restarts",
  { skip: process.platform === "win32" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-tunnel-")),
      script = path.join(dir, "fake.cjs"),
      exe = path.join(dir, "cloudflared");
    fs.writeFileSync(
      script,
      "const http=require('http');const s=http.createServer((q,r)=>r.end('ok'));s.listen(0,'127.0.0.1',()=>{console.log('Starting metrics server on 127.0.0.1:'+s.address().port);console.log('https://test-'+process.pid+'.trycloudflare.com');console.log('Registered tunnel connection');});",
    );
    fs.writeFileSync(
      exe,
      '#!/bin/sh\nexec "' + process.execPath + '" "' + script + '" "$@"\n',
      { mode: 0o700 },
    );
    save(path.join(dir, "config.json"), {
      port: await port(),
      tunnel: { mode: "quick", executable: exe },
    });
    t.after(async () => {
      try {
        await request(dir, "/stop", true);
      } catch {}
      await wait(400);
      await fsp.rm(dir, { recursive: true, force: true });
    });
    await ensure(dir);
    const first = await until(async () => {
      const s = await request(dir, "/status");
      return s.tunnelState === "online" && s.url && s;
    });
    process.kill(first.tunnelPid, "SIGKILL");
    const next = await until(async () => {
      const s = await request(dir, "/status");
      return (
        s.tunnelState === "online" &&
        s.tunnelPid !== first.tunnelPid &&
        s.url &&
        s
      );
    });
    assert.equal(first.webPid, next.webPid);
    assert.notEqual(first.url, next.url);
    assert.equal(
      fs.readFileSync(path.join(dir, "current-url.txt"), "utf8").trim(),
      next.url,
    );
  },
);
test(
  "Linux login startup registers only an explicit host profile and can be removed",
  { skip: process.platform !== "linux" },
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-startup-")),
      env = { ...process.env, XDG_CONFIG_HOME: path.join(dir, "config") };
    try {
      const on = applyStartup(dir, true, { env });
      assert(fs.readFileSync(on.target, "utf8").includes("--profile-dir"));
      assert(fs.readFileSync(on.target, "utf8").includes("host/cli.cjs"));
      applyStartup(dir, false, { env });
      assert(!fs.existsSync(on.target));
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  },
);
