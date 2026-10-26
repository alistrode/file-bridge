"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  cp = require("node:child_process");
const { directory, load, save } = require("./storage.cjs");
function request(profile, route, post = false) {
  const runtime = load(path.join(profile, "runtime.json"), null);
  if (!runtime?.controlOrigin) throw Error("Host is not running");
  return new Promise((resolve, reject) => {
    const req = http.request(
      runtime.controlOrigin + route,
      {
        method: post ? "POST" : "GET",
        timeout: 5000,
        headers: {
          "x-file-bridge-control": runtime.controlToken,
          "x-file-bridge-request": "1",
        },
      },
      (res) => {
        let body = "";
        res.on("data", (b) => (body += b));
        res.on("end", () => {
          try {
            if (res.statusCode !== 200) throw Error("Host control refused");
            resolve(JSON.parse(body));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("Host did not respond")));
    req.end();
  });
}
async function ensure(profile) {
  try {
    const s = await request(profile, "/status");
    if (s.pid) return s;
  } catch {}
  directory(profile);
  const end = Date.now() + 30000;
  let nextSpawn = 0,
    attempts = 0;
  while (Date.now() < end) {
    if (Date.now() >= nextSpawn) {
      const fd = fs.openSync(path.join(profile, "bootstrap.log"), "a", 0o600);
      const child = cp.spawn(
        process.execPath,
        [path.join(__dirname, "supervisor.cjs"), "--profile-dir", profile],
        { detached: true, stdio: ["ignore", fd, fd], windowsHide: true },
      );
      child.on("error", () => {});
      child.unref();
      fs.closeSync(fd);
      nextSpawn = Date.now() + Math.min(++attempts, 5) * 1000;
    }
    await new Promise((r) => setTimeout(r, 200));
    try {
      const state = await request(profile, "/status");
      if (state.webState === "online") return state;
    } catch {}
  }
  throw Error("Website startup failed; inspect this profile bootstrap.log");
}
function open(url) {
  if (!url) throw Error("Website entry is not ready");
  const u = new URL(url);
  if (!["http:", "https:"].includes(u.protocol))
    throw Error("Invalid website URL");
  if (process.platform === "win32") {
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const command = "Start-Process " + q(u.href);
    return cp.spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      { stdio: "ignore", windowsHide: true },
    );
  }
  return cp.spawn("xdg-open", [u.href], { stdio: "ignore" });
}
async function main() {
  const args = process.argv.slice(2),
    arg = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d),
    command = args[0] || "start",
    profile = path.resolve(
      arg("--profile-dir", path.join(__dirname, "../../var")),
    );
  if (command === "--help" || command === "help") {
    console.log(
      "start | status | stop | open | autostart on|off; --profile-dir DIR; start: --port 8790 --tunnel quick|named|off --cloudflared EXE; named: --tunnel-config FILE --tunnel-name NAME --public-url https://your-domain",
    );
    return;
  }
  if (command === "start") {
    directory(profile);
    const old = load(path.join(profile, "config.json"), null);
    let active = null;
    try {
      active = await request(profile, "/status");
    } catch {}
    if (active?.pid) {
      console.log(JSON.stringify(active, null, 2));
      return;
    }
    const port = Number(arg("--port", old?.port ?? 8790)),
      mode = arg("--tunnel", old?.tunnel.mode || "quick");
    if (
      !Number.isInteger(port) ||
      port < 0 ||
      port > 65535 ||
      !["quick", "named", "off"].includes(mode)
    )
      throw Error("Invalid host port or tunnel mode");
    const tunnel = {
      mode,
      executable: arg("--cloudflared", old?.tunnel.executable || "cloudflared"),
      config: arg("--tunnel-config", old?.tunnel.config),
      name: arg("--tunnel-name", old?.tunnel.name),
      publicOrigin: arg("--public-url", old?.tunnel.publicOrigin),
    };
    if (mode === "named") {
      if (
        !tunnel.config ||
        !tunnel.name ||
        !tunnel.publicOrigin ||
        new URL(tunnel.publicOrigin).protocol !== "https:"
      )
        throw Error(
          "Named tunnel requires --tunnel-config, --tunnel-name and --public-url https://...",
        );
      tunnel.config = path.resolve(tunnel.config);
      if (!fs.existsSync(tunnel.config))
        throw Error("Named tunnel configuration does not exist");
    }
    save(path.join(profile, "config.json"), { port, tunnel });
    console.log(JSON.stringify(await ensure(profile), null, 2));
  } else if (command === "status")
    console.log(JSON.stringify(await request(profile, "/status"), null, 2));
  else if (command === "stop")
    console.log(JSON.stringify(await request(profile, "/stop", true)));
  else if (command === "open") {
    const s = await request(profile, "/status");
    const child = open(s.url || s.localUrl);
    child.on("error", (e) => console.error(e.message));
  } else if (command === "autostart") {
    if (!["on", "off"].includes(args[1])) throw Error("Use autostart on|off");
    const { applyStartup } = require("./startup.cjs");
    if (!load(path.join(profile, "config.json"), null))
      throw Error("Start and configure the host before setting autostart");
    console.log(
      JSON.stringify(applyStartup(profile, args[1] === "on"), null, 2),
    );
  } else throw Error("Unknown command; use --help");
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { request, ensure, open };
