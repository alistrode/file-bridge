"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  cp = require("node:child_process");
function runNpm(args, options = {}) {
  if (process.platform !== "win32")
    return cp.spawnSync("npm", args, { ...options, shell: false });
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules/npm/bin/npm-cli.js",
    ),
  ];
  const where = cp.spawnSync("where.exe", ["npm.cmd"], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (where.status === 0)
    for (const entry of where.stdout.trim().split(/\r?\n/))
      candidates.push(
        path.join(path.dirname(entry), "node_modules/npm/bin/npm-cli.js"),
      );
  const cli = candidates.find(
    (p) => p && fs.existsSync(p) && /npm-cli\.(?:c?js)$/.test(p),
  );
  if (!cli)
    throw Error(
      "The source developer launcher requires a Node.js installation that includes npm. The prepared runtime package does not need npm.",
    );
  return cp.spawnSync(process.execPath, [cli, ...args], {
    ...options,
    shell: false,
  });
}
module.exports = { runNpm };
