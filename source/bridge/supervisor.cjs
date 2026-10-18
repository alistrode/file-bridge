"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
const { directory, load, save, retryDelay, logger } = require("./state.cjs");
const args = process.argv.slice(2),
  at = args.indexOf("--profile-dir");
if (at < 0) throw Error("Explicit profile required");
const profile = path.resolve(directory(args[at + 1])),
  lock = path.join(profile, "supervisor.lock"),
  log = logger(path.join(profile, "logs"));
try {
  fs.mkdirSync(lock, { mode: 0o700 });
} catch (e) {
  if (e.code !== "EEXIST") throw e;
  const v = load(path.join(lock, "owner.json"), {});
  try {
    if (v.pid) process.kill(v.pid, 0);
    else if (Date.now() - fs.statSync(lock).mtimeMs > 10000)
      throw Object.assign(Error(), { code: "ESRCH" });
    process.exit(0);
  } catch (err) {
    if (err.code !== "ESRCH") process.exit(0);
  }
  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock, { mode: 0o700 });
}
save(path.join(lock, "owner.json"), { pid: process.pid });
let child,
  timer,
  stable,
  stopping = false,
  failures = 0;
function cleanup() {
  clearTimeout(timer);
  clearTimeout(stable);
  fs.rmSync(lock, { recursive: true, force: true });
}
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  if (child) child.kill();
  else {
    cleanup();
    process.exit(0);
  }
}
function spawn() {
  if (stopping) return;
  log("supervisor_child_start", { attempt: failures + 1 });
  child = cp.spawn(
    process.execPath,
    [path.join(__dirname, "cli.cjs"), "serve", ...args],
    {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    },
  );
  child.stderr.on("data", () => log("backend_stderr"));
  child.on("error", (e) => log("backend_spawn_error", { reason: e.code }));
  child.on("message", (m) => {
    if (m?.type === "intentional-stop") stopping = true;
  });
  stable = setTimeout(() => (failures = 0), 30000);
  child.on("close", (code, signal) => {
    clearTimeout(stable);
    child = null;
    log("backend_exit", { exitStatus: code, signal });
    if (stopping) {
      cleanup();
      process.exit(0);
    }
    const delay = retryDelay(++failures);
    log("backend_retry", { attempt: failures, delayMs: delay });
    timer = setTimeout(spawn, delay);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
spawn();
