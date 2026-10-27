"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  cp = require("node:child_process");
const { directory, load, save, atomic, logger } = require("./storage.cjs");
const at = process.argv.indexOf("--profile-dir");
if (at < 0 || !process.argv[at + 1]) throw Error("Explicit profile required");
const profile = path.resolve(directory(process.argv[at + 1])),
  config = load(path.join(profile, "config.json"), null);
if (!config) throw Error("Host configuration missing");
const lock = path.join(profile, "host.lock"),
  runtimeFile = path.join(profile, "runtime.json"),
  log = logger(path.join(profile, "logs"));
try {
  fs.mkdirSync(lock);
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  const owner = load(path.join(lock, "owner.json"), {});
  try {
    if (owner.pid) process.kill(owner.pid, 0);
    else if (Date.now() - fs.statSync(lock).mtimeMs > 10000)
      throw Object.assign(Error(), { code: "ESRCH" });
    process.exit(0);
  } catch (err) {
    if (err.code !== "ESRCH") process.exit(0);
  }
  fs.rmSync(lock, { recursive: true, maxRetries: 10, retryDelay: 100 });
  fs.mkdirSync(lock);
}
save(path.join(lock, "owner.json"), { pid: process.pid });
let stopping = false,
  web,
  tunnel,
  webTimer,
  tunnelTimer,
  webStable,
  tunnelStable,
  probeTimer,
  webFailures = 0,
  tunnelFailures = 0,
  token,
  metricsOrigin,
  healthBusy = false,
  webProbeFailures = 0;
const admin = crypto.randomBytes(32).toString("hex");
const state = {
  pid: process.pid,
  version: require("../../package.json").version,
  webState: "starting",
  tunnelState: config.tunnel.mode === "off" ? "off" : "starting",
  webPid: null,
  tunnelPid: null,
  origin: null,
  url: null,
  localUrl: null,
  startedAt: new Date().toISOString(),
};
function publish() {
  save(runtimeFile, {
    ...state,
    controlToken: admin,
    controlOrigin: "http://127.0.0.1:" + control.address().port,
  });
  if (state.url)
    atomic(path.join(profile, "current-url.txt"), state.url + "\n");
  else if (fs.existsSync(path.join(profile, "current-url.txt")))
    fs.unlinkSync(path.join(profile, "current-url.txt"));
}
function delay(n) {
  return Math.min(n, 30) * 1000;
}
function urls() {
  state.localUrl =
    state.origin && token
      ? state.origin + "/?token=" + encodeURIComponent(token)
      : null;
  if (config.tunnel.mode === "off") state.url = state.localUrl;
  else if (config.tunnel.mode === "named")
    state.url =
      config.tunnel.publicOrigin && token
        ? config.tunnel.publicOrigin.replace(/\/$/, "") +
          "/?token=" +
          encodeURIComponent(token)
        : null;
}
function startWeb() {
  if (stopping) return;
  state.webState = "starting";
  publish();
  log("web_start", { attempt: webFailures + 1 });
  const child = cp.fork(path.join(__dirname, "../server.js"), [], {
    cwd: path.resolve(__dirname, "../.."),
    env: {
      ...process.env,
      FILE_BRIDGE_DATA_DIR: path.join(profile, "site"),
      HOST: "127.0.0.1",
      PORT: String(config.port),
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    windowsHide: true,
  });
  web = child;
  state.webPid = child.pid;
  publish();
  child.stderr.on("data", () => log("web_stderr"));
  child.on("error", (e) => log("web_spawn_error", { reason: e.code }));
  child.on("message", (m) => {
    if (m?.type !== "ready" || web !== child || stopping) return;
    const previousOrigin = state.origin;
    state.origin = "http://127.0.0.1:" + m.port;
    if (tunnel && previousOrigin !== state.origin) tunnel.kill();
    token = m.token;
    urls();
    state.webState = "online";
    webProbeFailures = 0;
    publish();
    log("web_online", { port: m.port });
    clearTimeout(webStable);
    webStable = setTimeout(() => (webFailures = 0), 30000);
    webStable.unref();
    if (!tunnel && config.tunnel.mode !== "off") startTunnel();
  });
  child.on("close", (code, signal) => {
    if (web !== child) return;
    web = null;
    clearTimeout(webStable);
    state.webPid = null;
    state.webState = stopping ? "stopped" : "recovering";
    publish();
    log("web_exit", { code, signal });
    if (!stopping) {
      const wait = delay(++webFailures);
      log("web_retry", { delayMs: wait });
      webTimer = setTimeout(startWeb, wait);
    } else finish();
  });
}
function startTunnel() {
  if (stopping || tunnel || !state.origin) return;
  clearTimeout(tunnelTimer);
  state.tunnelState = "connecting";
  metricsOrigin = null;
  publish();
  const args = [
    "tunnel",
    "--no-autoupdate",
    "--metrics",
    "127.0.0.1:0",
    "--protocol",
    "http2",
  ];
  if (config.tunnel.mode === "quick") args.push("--url", state.origin);
  else args.splice(1, 0, "--config", config.tunnel.config);
  if (config.tunnel.mode === "named") args.push("run", config.tunnel.name);
  log("tunnel_start", {
    attempt: tunnelFailures + 1,
    mode: config.tunnel.mode,
  });
  const child = cp.spawn(config.tunnel.executable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  tunnel = child;
  state.tunnelPid = child.pid;
  publish();
  let pending = "";
  function output(bytes) {
    pending += bytes.toString();
    if (pending.length > 100000) pending = pending.slice(-10000);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      const address = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (address && config.tunnel.mode === "quick" && token) {
        const next = address[0] + "/?token=" + encodeURIComponent(token);
        if (state.url !== next) {
          state.url = next;
          publish();
          log("tunnel_address_updated");
        }
      }
      const metric = line.match(
        /Starting metrics server on (127\.0\.0\.1:\d+)/,
      );
      if (metric) metricsOrigin = "http://" + metric[1];
      if (line.includes("Registered tunnel connection")) {
        state.tunnelState = "online";
        publish();
        log("tunnel_online");
        clearTimeout(tunnelStable);
        tunnelStable = setTimeout(() => (tunnelFailures = 0), 30000);
        tunnelStable.unref();
      }
    }
  }
  child.stdout.on("data", output);
  child.stderr.on("data", output);
  child.on("error", (e) => log("tunnel_spawn_error", { reason: e.code }));
  child.on("close", (code, signal) => {
    if (tunnel !== child) return;
    tunnel = null;
    clearTimeout(tunnelStable);
    state.tunnelPid = null;
    metricsOrigin = null;
    state.tunnelState = stopping ? "stopped" : "recovering";
    if (config.tunnel.mode === "quick") state.url = null;
    publish();
    log("tunnel_exit", { code, signal });
    if (!stopping) {
      const wait = delay(++tunnelFailures);
      log("tunnel_retry", { delayMs: wait });
      tunnelTimer = setTimeout(startTunnel, wait);
    } else finish();
  });
}
function get(url) {
  return new Promise((resolve) => {
    const r = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on("timeout", () => r.destroy());
    r.on("error", () => resolve(false));
  });
}
async function probe() {
  if (healthBusy || stopping) return;
  healthBusy = true;
  try {
    if (web && state.webState === "online") {
      if (await get(state.origin + "/health")) webProbeFailures = 0;
      else if (++webProbeFailures >= 3) {
        log("web_unresponsive");
        webProbeFailures = 0;
        web.kill("SIGKILL");
      }
    }
    if (metricsOrigin && tunnel) {
      const online = await get(metricsOrigin + "/ready");
      const next = online ? "online" : "reconnecting";
      if (next !== state.tunnelState) {
        state.tunnelState = next;
        publish();
        log(online ? "tunnel_recovered" : "tunnel_reconnecting");
      }
    }
  } finally {
    healthBusy = false;
  }
}
const control = http.createServer(async (req, res) => {
  if (
    req.headers.host !== "127.0.0.1:" + control.address().port ||
    req.headers["x-file-bridge-control"] !== admin
  ) {
    res.writeHead(403);
    return res.end();
  }
  if (req.method === "GET" && req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(state));
  }
  if (
    req.method === "POST" &&
    req.url === "/stop" &&
    req.headers["x-file-bridge-request"] === "1"
  ) {
    res.end('{"stopping":true}');
    return stop();
  }
  res.writeHead(404);
  res.end();
});
let finishing = false;
function finish() {
  if (!stopping || web || tunnel || finishing) return;
  finishing = true;
  clearInterval(probeTimer);
  state.webState = "stopped";
  state.tunnelState = "stopped";
  state.pid = null;
  publish();
  control.close();
  fs.rmSync(lock, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  log("host_stopped");
  setTimeout(() => process.exit(0), 50).unref();
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(webTimer);
  clearTimeout(tunnelTimer);
  clearTimeout(webStable);
  clearTimeout(tunnelStable);
  clearInterval(probeTimer);
  if (web) web.kill();
  if (tunnel) tunnel.kill();
  finish();
  setTimeout(() => {
    if (web) web.kill("SIGKILL");
    if (tunnel) tunnel.kill("SIGKILL");
  }, 6000).unref();
}
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, stop);
control.listen(0, "127.0.0.1", () => {
  publish();
  startWeb();
  probeTimer = setInterval(
    () => probe().catch(() => log("health_check_failed")),
    5000,
  );
  probeTimer.unref();
});
