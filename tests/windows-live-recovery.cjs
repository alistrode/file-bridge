"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const { request } = require("../source/host/cli.cjs");
const root = path.resolve(__dirname, ".."),
  profile = path.join(root, "var"),
  result = path.join(root, "artifacts/windows-live-recovery.json");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  const end = Date.now() + 120000;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await pause(500);
  }
  throw Error("Actual host recovery timed out");
}
(async () => {
  const first = await until(async () => {
    const s = await request(profile, "/status");
    return s.webState === "online" && s.tunnelState === "online" && s.url && s;
  });
  assert.equal(first.version, "3.0.0");
  const token = fs.readFileSync(path.join(profile, "site/token.txt"), "utf8"),
    before = JSON.parse(
      fs.readFileSync(path.join(profile, "site/items.json"), "utf8"),
    );
  process.kill(first.webPid, "SIGKILL");
  const web = await until(async () => {
    const s = await request(profile, "/status");
    return s.webState === "online" && s.webPid !== first.webPid && s;
  });
  assert.equal(web.origin, first.origin);
  assert.equal(web.tunnelPid, first.tunnelPid);
  assert.equal(
    fs.readFileSync(path.join(profile, "site/token.txt"), "utf8"),
    token,
  );
  const after = JSON.parse(
    fs.readFileSync(path.join(profile, "site/items.json"), "utf8"),
  );
  for (const item of before) assert(after.some((i) => i.id === item.id));
  process.kill(web.tunnelPid, "SIGKILL");
  const tunnel = await until(async () => {
    const s = await request(profile, "/status");
    return (
      s.tunnelState === "online" &&
      s.tunnelPid !== web.tunnelPid &&
      s.url &&
      s.url !== web.url &&
      s
    );
  });
  assert.equal(tunnel.webPid, web.webPid);
  assert.equal(
    fs.readFileSync(path.join(profile, "current-url.txt"), "utf8").trim(),
    tunnel.url,
  );
  const report = {
    passed: true,
    host: require("node:os").hostname(),
    platform: process.platform,
    node: process.version,
    checks: [
      "Actual Windows website process killed and automatically recovered",
      "Existing received items and access credential survived",
      "Website recovery kept the running Cloudflare tunnel",
      "Actual cloudflared process killed and automatically recovered",
      "Old temporary entry replaced with the new current address",
    ],
    webState: tunnel.webState,
    tunnelState: tunnel.tunnelState,
  };
  fs.writeFileSync(result, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch((e) => {
  fs.writeFileSync(
    result,
    JSON.stringify({ passed: false, error: e.message }, null, 2),
  );
  console.error(e.message);
  process.exitCode = 1;
});
