#!/usr/bin/env node
"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  http = require("node:http"),
  cp = require("node:child_process");
const { directory, load } = require("./state.cjs");
function request(profile, route, body) {
  const runtime = load(path.join(profile, "runtime.json"), null);
  if (!runtime) return Promise.reject(Error("File Bridge is not running"));
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: runtime.port,
        path: route,
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-file-bridge-token": runtime.token,
          "x-file-bridge-request": "1",
          "Content-Type": "application/json",
        },
        timeout: route === "/api/status" ? 4000 : 100000,
      },
      (res) => {
        let result = "";
        res.on("data", (d) => {
          result += d;
          if (result.length > 4000000) req.destroy(Error("Response too large"));
        });
        res.on("end", () => {
          try {
            const value = JSON.parse(result);
            res.statusCode < 300
              ? resolve(value)
              : reject(Error(value.error || "Request failed"));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("Request timeout")));
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function ensure(profile, broker) {
  try {
    await request(profile, "/api/status");
    return;
  } catch {}
  directory(profile);
  const deadline = Date.now() + 30000;
  let attempt = 0,
    nextSpawn = 0;
  while (Date.now() < deadline) {
    if (Date.now() >= nextSpawn) {
      const file = path.join(profile, "bootstrap.log"),
        fd = fs.openSync(file, "a", 0o600);
      const child = cp.spawn(
        process.execPath,
        [
          path.join(__dirname, "supervisor.cjs"),
          "--profile-dir",
          profile,
          ...(broker ? ["--broker", broker] : []),
        ],
        {
          detached: true,
          stdio: ["ignore", fd, fd],
          windowsHide: true,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        },
      );
      child.on("error", (e) => {
        try {
          fs.appendFileSync(
            file,
            "File Bridge supervisor spawn failed: " + (e.code || e.name) + "\n",
          );
        } catch {}
      });
      fs.closeSync(fd);
      child.unref();
      nextSpawn = Date.now() + ++attempt * 1000;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    try {
      await request(profile, "/api/status");
      return;
    } catch {}
  }
  throw Error("File Bridge startup failed; inspect this profile bootstrap log");
}
async function main() {
  const args = process.argv.slice(2),
    arg = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f),
    profile = path.resolve(
      arg("--profile-dir", path.join(os.homedir(), ".file-bridge-v2")),
    ),
    command = args[0] || "start";
  if (command === "serve") {
    const { App } = require("./app.cjs"),
      app = await new App({ profile, broker: arg("--broker") }).start();
    for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => app.stop());
    app.onStopped = () => process.exit(0);
    console.log("File Bridge backend ready");
    return;
  }
  if (command === "start") {
    await ensure(profile, arg("--broker"));
    console.log(
      "File Bridge started; private dashboard entry is in the selected profile runtime.json",
    );
    return;
  }
  if (command === "status")
    console.log(JSON.stringify(await request(profile, "/api/status"), null, 2));
  else if (command === "stop") await request(profile, "/api/shutdown", {});
  else if (command === "pair-code")
    console.log(JSON.stringify(await request(profile, "/api/pair/create", {})));
  else if (command === "pair") {
    const file = arg("--code-file");
    if (!file) throw Error("Use --code-file with a private pairing-code file");
    console.log(
      JSON.stringify(
        await request(profile, "/api/pair/join", {
          code: fs.readFileSync(file, "utf8").trim(),
        }),
      ),
    );
  } else
    throw Error(
      "Commands: start, status, stop, serve, pair-code, pair --code-file",
    );
}
if (require.main === module)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
module.exports = { request, ensure };
