"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  os = require("node:os");
function directory(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(p).isSymbolicLink())
    throw Error("State directory cannot be a symlink");
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
function save(p, value) {
  directory(path.dirname(p));
  if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink())
    throw Error("State file cannot be a symlink");
  const tmp = p + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmp, p);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
function retryDelay(failures) {
  if (!Number.isSafeInteger(failures) || failures < 1)
    throw Error("Invalid failure count");
  return Math.min(failures * 1000, 2147483000);
}
function identity(dir) {
  const p = path.join(dir, "identity.json");
  let v = load(p, null);
  if (!v) {
    const keys = crypto.generateKeyPairSync("ed25519");
    v = {
      id: crypto.randomUUID(),
      label: os.hostname(),
      publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
      privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    };
    save(p, v);
  }
  return v;
}
function validIdentity(v) {
  if (
    !v ||
    !/^[-a-f0-9]{36}$/.test(v.id) ||
    typeof v.label !== "string" ||
    v.label.length > 100 ||
    typeof v.publicKey !== "string" ||
    v.publicKey.length > 1000 ||
    crypto.createPublicKey(v.publicKey).asymmetricKeyType !== "ed25519"
  )
    throw Error("Invalid device identity");
  return v;
}
function publicIdentity(v) {
  return { id: v.id, label: v.label, publicKey: v.publicKey };
}
function key(secret, from, to) {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      Buffer.from(secret, "hex"),
      Buffer.from("file-bridge-v2"),
      Buffer.from(from + ":" + to),
      32,
    ),
  );
}
function seal(secret, from, to, value, privateKey) {
  const iv = crypto.randomBytes(12),
    cipher = crypto.createCipheriv("aes-256-gcm", key(secret, from, to), iv);
  cipher.setAAD(Buffer.from(from + ":" + to));
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  const body = JSON.stringify({
    v: 2,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  });
  return JSON.stringify({
    body,
    signature: crypto
      .sign(null, Buffer.from(body), privateKey)
      .toString("base64"),
  });
}
function unseal(secret, from, to, wire, publicKey) {
  if (wire.length > 140000) throw Error("Frame too large");
  const outer = JSON.parse(wire);
  if (
    typeof outer.body !== "string" ||
    !crypto.verify(
      null,
      Buffer.from(outer.body),
      publicKey,
      Buffer.from(outer.signature, "base64"),
    )
  )
    throw Error("Invalid signature");
  const p = JSON.parse(outer.body);
  if (p.v !== 2) throw Error("Unsupported protocol");
  const dec = crypto.createDecipheriv(
    "aes-256-gcm",
    key(secret, from, to),
    Buffer.from(p.iv, "base64"),
  );
  dec.setAAD(Buffer.from(from + ":" + to));
  dec.setAuthTag(Buffer.from(p.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      dec.update(Buffer.from(p.data, "base64")),
      dec.final(),
    ]).toString(),
  );
}
function logger(dir) {
  const file = path.join(directory(dir), "events.jsonl");
  return (event, fields = {}) => {
    const entry = { time: new Date().toISOString(), event, ...fields };
    let line =
      JSON.stringify(entry, (k, v) =>
        /secret|token|password|privateKey|code|text|body|data|url/i.test(k)
          ? "[REDACTED]"
          : v,
      ) + "\n";
    if (Buffer.byteLength(line) > 8192)
      line =
        JSON.stringify({ time: entry.time, event: "oversize_event_redacted" }) +
        "\n";
    try {
      if (
        fs.existsSync(file) &&
        fs.statSync(file).size + Buffer.byteLength(line) > 2 * 1024 * 1024
      ) {
        for (let i = 3; i >= 1; i--) {
          const old = file + "." + i;
          if (i === 3) fs.rmSync(old, { force: true });
          else if (fs.existsSync(old)) fs.renameSync(old, file + "." + (i + 1));
        }
        fs.renameSync(file, file + ".1");
      }
      fs.appendFileSync(file, line, { mode: 0o600 });
    } catch (e) {
      process.stderr.write("File Bridge log write failed: " + e.code + "\n");
    }
  };
}
module.exports = {
  directory,
  load,
  save,
  retryDelay,
  identity,
  validIdentity,
  publicIdentity,
  seal,
  unseal,
  logger,
};
