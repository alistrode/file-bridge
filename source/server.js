"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  fsp = require("node:fs/promises"),
  path = require("node:path"),
  crypto = require("node:crypto");
const {
  directory,
  load,
  atomic,
  save,
  syncDirectory,
  logger,
} = require("./host/storage.cjs");
const ROOT = __dirname,
  CHUNK = 1024 * 1024,
  MAX_FILE = 1024 * 1024 * 1024,
  DAY = 86400000;
const data = directory(
  path.resolve(process.env.FILE_BRIDGE_DATA_DIR || path.join(ROOT, "data")),
);
const received = directory(
  process.env.FILE_BRIDGE_STORAGE || path.join(data, "received"),
);
const archive = directory(path.join(data, "archive")),
  uploads = directory(path.join(data, "uploads"));
const log = logger(path.join(data, "logs")),
  itemsFile = path.join(data, "items.json"),
  archiveFile = path.join(archive, "items.json");
const tokenFile = path.join(data, "token.txt");
let token = process.env.FILE_BRIDGE_TOKEN;
if (!token) {
  try {
    token = fs.readFileSync(tokenFile, "utf8").trim();
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
}
if (!token) {
  token = crypto.randomBytes(32).toString("hex");
  atomic(tokenFile, token);
}
// Preserve the original direct-server files; supervised profiles are separate stores.
if (!process.env.FILE_BRIDGE_DATA_DIR) {
  for (const [from, to] of [
    [path.join(ROOT, "received"), received],
    [path.join(ROOT, "archive/files"), archive],
  ])
    if (fs.existsSync(from))
      for (const f of fs.readdirSync(from)) {
        const src = path.join(from, f),
          dst = path.join(to, f);
        if (fs.lstatSync(src).isFile() && !fs.existsSync(dst))
          fs.copyFileSync(src, dst);
      }
  if (
    !fs.existsSync(archiveFile) &&
    fs.existsSync(path.join(ROOT, "archive/items.json"))
  )
    save(archiveFile, load(path.join(ROOT, "archive/items.json"), []));
}
let items = load(itemsFile, []),
  archived = load(archiveFile, []);
const busy = new Set();
const pendingArchives = new Map();
const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
const uuid = (s) =>
  typeof s === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
const name = (s) => {
  const clean = path
    .basename(String(s || "file.bin"))
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_");
  let result = "";
  for (const char of clean) {
    if (Buffer.byteLength(result + char) > 170) break;
    result += char;
  }
  return result || "file.bin";
};
const fail = (status, message) => Object.assign(Error(message), { status });
function record(item) {
  const existing = items.find((x) => x.id === item.id);
  if (existing) return existing;
  const next = [item, ...items];
  save(itemsFile, next);
  items = next;
  return item;
}
function clean() {
  const cutoff = Date.now() - DAY;
  const expired = items.filter((i) => i.createdAt < cutoff);
  items = items.filter((i) => i.createdAt >= cutoff);
  save(itemsFile, items);
  for (const i of expired)
    if (i.download) {
      const f = path.basename(decodeURIComponent(i.download.split("/").at(-1)));
      fs.rmSync(path.join(received, f), { force: true });
    }
  for (const id of fs.readdirSync(uploads)) {
    if (!uuid(id)) continue;
    const dir = path.join(uploads, id),
      m = load(path.join(dir, "job.json"), null);
    if (m && Date.now() - m.updatedAt > 7 * DAY)
      fs.rmSync(dir, { recursive: true, force: true });
  }
}
clean();
const cleanup = setInterval(() => {
  try {
    clean();
  } catch (e) {
    log("cleanup_failed", { reason: e.code || "storage" });
  }
}, 3600000);
cleanup.unref();
function job(id) {
  if (!uuid(id)) throw fail(400, "上传编号无效");
  const dir = path.join(uploads, id),
    m = load(path.join(dir, "job.json"), null);
  if (!m) throw fail(404, "上传记录已过期，请重新发送");
  return { dir, m };
}
async function snapshot(id) {
  const { dir, m } = job(id);
  const present = [];
  const item = items.find((x) => x.id === m.id) || null;
  if (
    m.state === "completed" &&
    item &&
    fs.existsSync(path.join(received, m.target))
  )
    return { id: m.id, state: m.state, chunkBytes: CHUNK, present, item };
  for (let i = 0; i < m.blocks.length; i++) {
    try {
      const bytes = await fsp.readFile(path.join(dir, String(i)));
      if (
        bytes.length === Math.min(CHUNK, m.size - i * CHUNK) &&
        hash(bytes) === m.blocks[i]
      )
        present.push(i);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return { id: m.id, state: "uploading", chunkBytes: CHUNK, present, item };
}
function auth(req, u) {
  const values = [
    req.headers["x-file-bridge-token"],
    u.searchParams.get("token"),
  ];
  const cookie = req.headers.cookie?.match(
    /(?:^|; )fileBridgeToken=([^;]+)/,
  )?.[1];
  if (cookie) {
    try {
      values.push(decodeURIComponent(cookie));
    } catch {}
  }
  return values.some(
    (v) =>
      typeof v === "string" &&
      Buffer.byteLength(v) === Buffer.byteLength(token) &&
      crypto.timingSafeEqual(Buffer.from(v), Buffer.from(token)),
  );
}
function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
async function body(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const b of req) {
    size += b.length;
    if (size > limit) throw fail(413, "内容超过大小限制");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
async function object(req) {
  try {
    return JSON.parse((await body(req, 6500000)).toString());
  } catch (e) {
    if (e.status) throw e;
    throw fail(400, "请求格式无效");
  }
}
async function locked(id, fn) {
  if (busy.has(id)) throw fail(409, "任务正在处理，请稍后重试");
  busy.add(id);
  try {
    return await fn();
  } finally {
    busy.delete(id);
  }
}
async function complete(id) {
  return locked(id, async () => {
    const { dir, m } = job(id);
    const previous = items.find((x) => x.id === id);
    const expectedTarget = m.target || id + "-" + name(m.name);
    if (
      previous &&
      (previous.kind === "text" ||
        previous.download !==
          "/api/download/" + encodeURIComponent(expectedTarget) ||
        previous.size !== m.size)
    )
      throw fail(409, "任务编号已用于其他内容");
    if (
      m.state === "completed" &&
      previous &&
      fs.existsSync(path.join(received, m.target))
    )
      return previous;
    const target = m.target || id + "-" + name(m.name),
      temp = path.join(received, target + ".part"),
      out = await fsp.open(temp, "w", 0o600),
      full = crypto.createHash("sha256");
    try {
      for (let i = 0; i < m.blocks.length; i++) {
        let bytes;
        try {
          bytes = await fsp.readFile(path.join(dir, String(i)));
        } catch (e) {
          if (e.code === "ENOENT") throw fail(409, "分块尚未上传完整");
          throw e;
        }
        if (
          bytes.length !== Math.min(CHUNK, m.size - i * CHUNK) ||
          hash(bytes) !== m.blocks[i]
        )
          throw fail(409, "分块校验失败，请继续上传");
        full.update(bytes);
        let offset = 0;
        while (offset < bytes.length) {
          const r = await out.write(bytes, offset, bytes.length - offset);
          offset += r.bytesWritten;
        }
      }
      await out.sync();
    } finally {
      await out.close();
    }
    if ((await fsp.stat(temp)).size !== m.size)
      throw fail(409, "文件长度校验失败");
    const digest = full.digest("hex");
    m.target = target;
    m.digest = digest;
    m.updatedAt = Date.now();
    save(path.join(dir, "job.json"), m);
    await fsp.rename(temp, path.join(received, target));
    syncDirectory(received);
    const item = record({
      id,
      kind: m.mime.startsWith("image/") ? "image" : "file",
      name: m.name,
      size: m.size,
      mime: m.mime,
      digest,
      verified: true,
      createdAt: Date.now(),
      download: "/api/download/" + encodeURIComponent(target),
    });
    m.state = "completed";
    save(path.join(dir, "job.json"), m);
    log("upload_saved", { bytes: m.size });
    return item;
  });
}
function archiveItem(id) {
  if (pendingArchives.has(id)) return pendingArchives.get(id);
  const operation = (async () => {
    const item = items.find((i) => i.id === id);
    if (!item) throw fail(404, "内容已过期");
    if (archived.some((i) => i.id === id)) return;
    const copy = { ...item, archivedAt: Date.now() };
    if (item.download) {
      const src = path.join(
          received,
          path.basename(decodeURIComponent(item.download.split("/").at(-1))),
        ),
        dst = path.join(archive, path.basename(src));
      await fsp.copyFile(src, dst);
      const h = await fsp.open(dst, "r+");
      try {
        await h.sync();
      } finally {
        await h.close();
      }
      syncDirectory(archive);
      copy.download =
        "/api/archive-download/" + encodeURIComponent(path.basename(dst));
    }
    const next = [copy, ...archived];
    save(archiveFile, next);
    archived = next;
  })().finally(() => pendingArchives.delete(id));
  pendingArchives.set(id, operation);
  return operation;
}
async function serve(req, res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  const u = new URL(req.url, "http://localhost");
  if (req.method === "GET" && u.pathname === "/health")
    return json(res, 200, { ok: true });
  if (!auth(req, u))
    return json(res, 401, { error: "请使用主机提供的完整网址打开网页" });
  if (
    !["GET", "HEAD"].includes(req.method) &&
    req.headers["x-file-bridge-request"] !== "1"
  )
    throw fail(403, "请求校验失败");
  if (
    req.method === "GET" &&
    ["/", "/app.js", "/style.css"].includes(u.pathname)
  ) {
    if (u.pathname === "/")
      res.setHeader(
        "Set-Cookie",
        "fileBridgeToken=" +
          encodeURIComponent(token) +
          "; HttpOnly; SameSite=Strict; Path=/" +
          (req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""),
      );
    const file = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
    res.writeHead(200, {
      "Content-Type": file.endsWith(".js")
        ? "text/javascript"
        : file.endsWith(".css")
          ? "text/css"
          : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(await fsp.readFile(path.join(ROOT, "public", file)));
  }
  if (req.method === "GET" && u.pathname === "/api/items") {
    const saved = new Set(archived.map((i) => i.id));
    return json(res, 200, {
      items: items.map((item) => ({ ...item, archived: saved.has(item.id) })),
    });
  }
  if (req.method === "POST" && u.pathname === "/api/text") {
    const v = await object(req);
    if (
      !uuid(v.id) ||
      typeof v.text !== "string" ||
      !v.text.trim() ||
      Buffer.byteLength(v.text) > 1024 * 1024
    )
      throw fail(400, "文字内容或任务编号无效");
    const old = items.find((i) => i.id === v.id);
    if (old && (old.kind !== "text" || old.text !== v.text.trim()))
      throw fail(409, "任务编号已用于其他内容");
    return json(res, 201, {
      ok: true,
      item: record({
        id: v.id,
        kind: "text",
        text: v.text.trim(),
        createdAt: Date.now(),
      }),
    });
  }
  if (req.method === "POST" && u.pathname === "/api/uploads") {
    const v = await object(req);
    if (
      !uuid(v.id) ||
      !Number.isSafeInteger(v.size) ||
      v.size < 0 ||
      v.size > MAX_FILE ||
      typeof v.name !== "string" ||
      !Array.isArray(v.blocks) ||
      v.blocks.length !== Math.ceil(v.size / CHUNK) ||
      !v.blocks.every((x) => /^[a-f0-9]{64}$/.test(x)) ||
      hash(v.blocks.join("")) !== v.manifest
    )
      throw fail(400, "文件清单无效或文件超过 1 GB");
    const occupied = items.find((i) => i.id === v.id);
    if (
      occupied &&
      (occupied.kind === "text" ||
        !fs.existsSync(path.join(uploads, v.id, "job.json")))
    )
      throw fail(409, "任务编号已用于其他内容");
    let canonical = v.id;
    for (const candidate of fs.readdirSync(uploads)) {
      if (!uuid(candidate)) continue;
      const other = load(path.join(uploads, candidate, "job.json"), null);
      if (
        other &&
        other.manifest === v.manifest &&
        other.size === v.size &&
        other.name === name(v.name) &&
        other.mime ===
          String(v.mime || "application/octet-stream").slice(0, 100) &&
        (other.state !== "completed" || items.some((x) => x.id === candidate))
      ) {
        canonical = candidate;
        break;
      }
    }
    return locked(canonical, async () => {
      const dir = directory(path.join(uploads, canonical)),
        old = load(path.join(dir, "job.json"), null);
      if (
        old &&
        (old.manifest !== v.manifest ||
          old.size !== v.size ||
          old.name !== name(v.name) ||
          old.mime !==
            String(v.mime || "application/octet-stream").slice(0, 100))
      )
        throw fail(409, "任务编号对应的文件已改变");
      if (!old)
        save(path.join(dir, "job.json"), {
          id: canonical,
          name: name(v.name),
          size: v.size,
          mime: String(v.mime || "application/octet-stream").slice(0, 100),
          blocks: v.blocks,
          manifest: v.manifest,
          state: "uploading",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
      else {
        old.updatedAt = Date.now();
        save(path.join(dir, "job.json"), old);
      }
      return json(res, 200, await snapshot(canonical));
    });
  }
  const match = u.pathname.match(
    /^\/api\/uploads\/([^/]+)(?:\/(chunks)\/(\d+)|\/(complete))?$/,
  );
  if (match) {
    const id = match[1];
    if (req.method === "GET" && !match[2] && !match[4])
      return json(res, 200, await snapshot(id));
    if (req.method === "PUT" && match[2])
      return locked(id, async () => {
        const { dir, m } = job(id),
          i = Number(match[3]);
        if (!Number.isSafeInteger(i) || i < 0 || i >= m.blocks.length)
          throw fail(400, "分块编号无效");
        const bytes = await body(req, CHUNK);
        if (
          bytes.length !== Math.min(CHUNK, m.size - i * CHUNK) ||
          hash(bytes) !== m.blocks[i]
        )
          throw fail(422, "文件分块校验失败");
        atomic(path.join(dir, String(i)), bytes);
        m.updatedAt = Date.now();
        save(path.join(dir, "job.json"), m);
        return json(res, 200, { saved: true, index: i });
      });
    if (req.method === "POST" && match[4])
      return json(res, 201, { saved: true, item: await complete(id) });
  }
  if (req.method === "POST" && u.pathname.startsWith("/api/archive/")) {
    await archiveItem(u.pathname.slice("/api/archive/".length));
    return json(res, 201, { ok: true });
  }
  if (req.method === "GET" && u.pathname === "/api/archives")
    return json(res, 200, { items: archived });
  if (
    req.method === "GET" &&
    /^\/api\/(download|archive-download|preview)\//.test(u.pathname)
  ) {
    const parts = u.pathname.split("/"),
      kind = parts[2],
      file = decodeURIComponent(parts.slice(3).join("/"));
    if (file !== path.basename(file) || file === "." || file === "..")
      throw fail(400, "文件名无效");
    const list = kind === "archive-download" ? archived : items,
      item = list.find(
        (i) =>
          i.download &&
          decodeURIComponent(i.download.split("/").at(-1)) === file,
      );
    if (!item) throw fail(404, "文件不存在或已过期");
    const target = path.join(
      kind === "archive-download" ? archive : received,
      file,
    );
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch (e) {
      if (e.code === "ENOENT") throw fail(404, "文件不存在");
      throw e;
    }
    const preview = kind === "preview";
    if (preview && !/^image\/(png|jpeg|gif|webp)$/.test(item.mime))
      throw fail(415, "此格式请下载查看");
    const headers = {
      "Content-Type": preview ? item.mime : "application/octet-stream",
      "Content-Disposition":
        (preview ? "inline" : "attachment") +
        "; filename*=UTF-8''" +
        encodeURIComponent(item.name || file),
      "Content-Length": stat.size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store",
    };
    let start = 0,
      end = stat.size - 1,
      status = 200;
    if (req.headers.range) {
      const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
      if (!r || Number(r[1]) >= stat.size) {
        res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
        return res.end();
      }
      start = Number(r[1]);
      end = r[2] ? Math.min(Number(r[2]), end) : end;
      if (end < start) {
        res.writeHead(416, { "Content-Range": "bytes */" + stat.size });
        return res.end();
      }
      status = 206;
      headers["Content-Length"] = end - start + 1;
      headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    }
    res.writeHead(status, headers);
    if (!stat.size) return res.end();
    const stream = fs.createReadStream(target, { start, end });
    stream.on("error", () => res.destroy());
    res.on("close", () => stream.destroy());
    return stream.pipe(res);
  }
  throw fail(404, "接口不存在");
}
const server = http.createServer((req, res) => {
  serve(req, res).catch((e) => {
    if (!e.status) log("request_failed", { reason: e.code || "internal" });
    if (res.headersSent) return res.destroy();
    json(res, e.status || 500, {
      error: e.status ? e.message : "保存失败，请稍后重试",
    });
  });
});
server.requestTimeout = 120000;
server.headersTimeout = 15000;
server.listen(
  Number(process.env.PORT ?? 8790),
  process.env.HOST || "127.0.0.1",
  () => {
    const port = server.address().port;
    log("web_ready", { port });
    if (process.send) process.send({ type: "ready", port, token });
    else
      console.log(
        "File Bridge website ready on port " +
          port +
          "; private entry is stored in the data directory.",
      );
  },
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    clearInterval(cleanup);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
