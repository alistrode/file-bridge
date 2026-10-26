"use strict";
// Run in the actual Windows desktop user's session, never the SSH SYSTEM session.
const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  cp = require("node:child_process");
const { save } = require("../source/host/storage.cjs"),
  { ensure, request } = require("../source/host/cli.cjs"),
  { applyStartup } = require("../source/host/startup.cjs");
const root = path.resolve(__dirname, ".."),
  profile = path.join(root, "var-startup-check"),
  result = path.join(root, "artifacts/windows-startup-result.json");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let phase = "initialization";
function stage(value) {
  phase = value;
  fs.appendFileSync(
    path.join(root, "artifacts/windows-startup-progress.log"),
    value + "\n",
  );
}
async function until(fn) {
  const end = Date.now() + 90000;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    await wait(250);
  }
  throw Error("Login startup verification timed out");
}
(async () => {
  if (
    process.platform !== "win32" ||
    /^system$/i.test(process.env.USERNAME || "")
  )
    throw Error("Run this test as the logged-in Windows desktop user");
  fs.mkdirSync(path.dirname(result), { recursive: true });
  save(path.join(profile, "config.json"), { port: 0, tunnel: { mode: "off" } });
  let target;
  try {
    stage("start isolated host");
    const first = await ensure(profile),
      token = fs.readFileSync(path.join(profile, "site/token.txt"), "utf8");
    stage("register startup shortcut");
    const on = applyStartup(profile, true);
    target = on.target;
    assert(fs.existsSync(target));
    stage("stop isolated host");
    await request(profile, "/stop", true);
    await until(() => !fs.existsSync(path.join(profile, "host.lock")));
    stage("launch through actual Startup shortcut");
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const command = "Start-Process -FilePath " + q(target);
    const launch = cp.spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
    launch.on("error", () => {});
    launch.unref();
    const next = await until(async () => {
      const s = await request(profile, "/status");
      return s.webState === "online" && s.pid !== first.pid && s;
    });
    assert.equal(
      fs.readFileSync(path.join(profile, "site/token.txt"), "utf8"),
      token,
    );
    assert.equal((await fetch(next.origin + "/health")).status, 200);
    stage("remove test startup shortcut");
    applyStartup(profile, false);
    assert(!fs.existsSync(target));
    const report = {
      passed: true,
      user: process.env.USERNAME,
      checks: [
        "Actual current-user Startup shortcut registered",
        "Stopped test host relaunches through its Startup shortcut",
        "Website is healthy and keeps its access credential",
        "Test login startup entry removed after verification",
      ],
      rebootPerformed: false,
    };
    fs.writeFileSync(result, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
  } finally {
    if (target)
      try {
        applyStartup(profile, false);
      } catch {}
    try {
      await request(profile, "/stop", true);
    } catch {}
  }
})().catch((e) => {
  fs.mkdirSync(path.dirname(result), { recursive: true });
  fs.writeFileSync(
    result,
    JSON.stringify(
      { passed: false, user: process.env.USERNAME, phase, error: e.message },
      null,
      2,
    ),
  );
  console.error(e.message);
  process.exitCode = 1;
});
