"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  os = require("node:os"),
  path = require("node:path"),
  cp = require("node:child_process");
const { atomic } = require("../source/host/storage.cjs");
test(
  "Windows temporary read locks do not break durable state replacement",
  { skip: process.platform !== "win32" },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-bridge-lock-")),
      file = path.join(dir, "runtime.json");
    fs.writeFileSync(file, "previous");
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    const script =
      "$f=[IO.File]::Open(" +
      q(file) +
      ",[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);[Console]::WriteLine('LOCKED');[Console]::Out.Flush();Start-Sleep -Milliseconds 1000;$f.Dispose()";
    const p = cp.spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let error = "";
    p.stderr.on("data", (b) => (error += b));
    t.after(async () => {
      if (p.exitCode === null) p.kill();
      await fsp.rm(dir, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Reader lock did not start " + error)),
        15000,
      );
      p.stdout.on("data", (b) => {
        if (b.toString().includes("LOCKED")) {
          clearTimeout(timer);
          resolve();
        }
      });
      p.once("error", reject);
      p.once("exit", (code) => {
        if (code) reject(Error("Reader failed " + error));
      });
    });
    const start = Date.now();
    atomic(file, "recovered");
    assert.equal(fs.readFileSync(file, "utf8"), "recovered");
    assert(
      Date.now() - start >= 100,
      "Replacement must actually wait for the other process to release its deny-delete handle",
    );
  },
);

// Simulate a failed filesystem write, then check the externally visible durable state.
test("Failed state writes preserve the previous state and do not leave partial staging files", async () => {
  const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "file-bridge-write-fault-"),
    ),
    file = path.join(dir, "runtime.json");
  fs.writeFileSync(file, "previous");
  const original = fs.writeFileSync;
  try {
    fs.writeFileSync = () => {
      throw Object.assign(Error("injected disk write failure"), {
        code: "EIO",
      });
    };
    assert.throws(() => atomic(file, "new"), /injected disk write failure/);
  } finally {
    fs.writeFileSync = original;
  }
  try {
    assert.equal(fs.readFileSync(file, "utf8"), "previous");
    assert.deepEqual(fs.readdirSync(dir), ["runtime.json"]);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
