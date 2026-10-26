"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
function directory(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(p).isSymbolicLink())
    throw Error("Symbolic-link storage directory refused");
  return p;
}
function load(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}
function syncDirectory(p) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(p, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
// Windows scanners and readers can briefly deny replacement of an otherwise writable file.
// Retry the atomic replacement itself; never delete the valid destination to make it succeed.
function replace(from, to) {
  const deadline = Date.now() + 5000;
  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(e.code) ||
        Date.now() >= deadline
      )
        throw e;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(10 * 2 ** attempt++, 200),
      );
    }
  }
}
function atomic(p, data) {
  directory(path.dirname(p));
  if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
    throw Error("Symbolic-link destination refused");
  const tmp = p + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
  try {
    const fd = fs.openSync(tmp, "wx", 0o600);
    try {
      fs.writeFileSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    replace(tmp, p);
    syncDirectory(path.dirname(p));
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}
function save(p, v) {
  atomic(p, JSON.stringify(v) + "\n");
}
function logger(dir) {
  directory(dir);
  const file = path.join(dir, "events.jsonl");
  return (event, fields = {}) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) {
        for (let i = 2; i >= 0; i--) {
          const from = i ? file + "." + i : file,
            to = file + "." + (i + 1);
          if (fs.existsSync(from)) {
            if (fs.existsSync(to)) fs.unlinkSync(to);
            replace(from, to);
          }
        }
      }
      fs.appendFileSync(
        file,
        JSON.stringify({ time: new Date().toISOString(), event, ...fields }) +
          "\n",
        { mode: 0o600 },
      );
    } catch {
      /* Diagnostic logging must not terminate the supervised service. */
    }
  };
}
module.exports = { directory, load, atomic, save, syncDirectory, logger };
