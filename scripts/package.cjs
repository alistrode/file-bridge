"use strict";
// Packaging copies the already verified runtime and locked production dependencies;
// it does not compile Chromium or rebuild JavaScript.
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const { runNpm } = require("./npm.cjs");
const args = process.argv.slice(2),
  at = (n) => args[args.indexOf(n) + 1],
  platform = at("--platform"),
  runtime = path.resolve(at("--runtime") || ""),
  out = path.resolve(at("--out") || "");
if (
  !["win32", "linux"].includes(platform) ||
  !args.includes("--runtime") ||
  !args.includes("--out")
)
  throw Error(
    "Use --platform win32|linux --runtime verified-electron-directory --out new-folder",
  );
if (fs.existsSync(out)) throw Error("Output must be a new directory");
const root = path.resolve(__dirname, "..");
fs.mkdirSync(out, { recursive: true });
for (const name of [
  "source/bridge",
  "scripts",
  "package.json",
  "package-lock.json",
  "Start-File-Bridge.cmd",
  "Start-File-Bridge.sh",
  "File-Bridge-CLI.cmd",
  "File-Bridge-CLI.sh",
  "docs/RUNTIME-SOURCES.json",
  "README.md",
])
  fs.cpSync(path.join(root, name), path.join(out, name), { recursive: true });
fs.cpSync(runtime, path.join(out, "runtime"), { recursive: true });
const runtimeName = platform === "win32" ? "FileBridge.exe" : "file-bridge";
const upstreamName = platform === "win32" ? "electron.exe" : "electron";
fs.renameSync(
  path.join(out, "runtime", upstreamName),
  path.join(out, "runtime", runtimeName),
);
const npm = process.platform === "win32" ? "npm.cmd" : "npm",
  r = runNpm(
    [
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--cache",
      process.env.FB_NPM_CACHE || path.join(root, "..", "npm-cache"),
    ],
    { cwd: out, stdio: "inherit", shell: process.platform === "win32" },
  );
if (r.status !== 0) throw Error("Production dependency install failed");
if (!fs.existsSync(path.join(out, "runtime", runtimeName)))
  throw Error("Runtime missing platform executable");
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.isFile())
      files.push({
        path: path.relative(out, full).split(path.sep).join("/"),
        bytes: fs.statSync(full).size,
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex"),
      });
  }
}
walk(out);
fs.writeFileSync(
  path.join(out, "PACKAGE-MANIFEST.json"),
  JSON.stringify(
    { product: "File Bridge", version: "2.0.0", platform, runtimeExecutable: "runtime/" + runtimeName, files },
    null,
    2,
  ),
);
console.log(
  "Packaged " +
    files.length +
    " files. Runtime verification remains a separate required step.",
);
