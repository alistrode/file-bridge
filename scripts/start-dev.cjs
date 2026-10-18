#!/usr/bin/env node
"use strict";
const cp = require("node:child_process"),
  path = require("node:path"),
  fs = require("node:fs");
const { runNpm } = require("./npm.cjs");
const root = path.resolve(__dirname, ".."),
  args = process.argv.slice(2),
  headless = args.includes("--headless"),
  filtered = args.filter((x) => x !== "--headless"),
  npm = process.platform === "win32" ? "npm.cmd" : "npm";
function run(exe, argv, env) {
  const launch =
    exe === npm
      ? (program, parameters, opts) => runNpm(parameters, opts)
      : cp.spawnSync;
  const r = launch(exe, argv, {
    cwd: root,
    stdio: "inherit",
    env: env || process.env,
    shell: false,
  });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (Number(process.versions.node.split(".")[0]) < 22)
  throw Error("File Bridge needs Node.js 22 or newer");
if (!fs.existsSync(path.join(root, "node_modules/mqtt/package.json")))
  run(npm, [
    "ci",
    "--omit=dev",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    path.join(root, "..", "npm-cache"),
  ]);
if (headless) {
  run(process.execPath, ["source/bridge/cli.cjs", "start", ...filtered]);
  process.exit(0);
}
let electron;
try {
  electron = process.env.FILE_BRIDGE_ELECTRON || require("electron");
  if (!fs.existsSync(electron)) throw Error();
} catch {
  run(npm, [
    "ci",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--cache",
    path.join(root, "..", "npm-cache"),
  ]);
  run(process.execPath, ["scripts/download-runtime.cjs"], process.env);
  electron = require("electron");
}
const p = cp.spawn(
  electron,
  [
    ...(process.platform === "linux" ? ["--disable-setuid-sandbox"] : []),
    root,
    ...filtered,
  ],
  {
    cwd: root,
    stdio: "inherit",
    windowsHide: false,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  },
);
p.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
p.on("exit", (c) => process.exit(c || 0));
