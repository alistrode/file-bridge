"use strict";
const http = require("node:http"),
  fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  os = require("node:os");
const { Bridge, MAX_FILE, digest } = require("./engine.cjs");
const { directory, load, save } = require("./state.cjs");
const { launchBrowser, applyStartup, startupPath } = require("./platform.cjs");
class App {
  constructor({
    profile = path.join(os.homedir(), ".file-bridge-v2"),
    broker,
    openBrowser = launchBrowser,
    networkFactory,
  } = {}) {
    this.profile = path.resolve(profile);
    this.broker = broker;
    this.openBrowser = openBrowser;
    this.networkFactory = networkFactory;
    this.token = crypto.randomBytes(32).toString("hex");
    this.lock = path.join(this.profile, "instance.lock");
  }
  async start() {
    directory(this.profile);
    try {
      fs.mkdirSync(this.lock, { mode: 0o700 });
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const owner = load(path.join(this.lock, "owner.json"), {});
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (err) {
        alive = err.code !== "ESRCH" && err.code !== "EINVAL";
      }
      if (!owner.pid && Date.now() - fs.statSync(this.lock).mtimeMs > 10000)
        alive = false;
      if (alive)
        throw Error("This File Bridge profile is already running or starting");
      fs.rmSync(this.lock, { recursive: true });
      fs.mkdirSync(this.lock, { mode: 0o700 });
    }
    save(path.join(this.lock, "owner.json"), { pid: process.pid });
    try {
      this.bridge = new Bridge({
        profile: this.profile,
        broker: this.broker,
        networkFactory: this.networkFactory,
      });
      this.server = http.createServer((q, s) =>
        this.api(q, s).catch((e) => {
          this.bridge.log("http_request_failed", {
            reason: e.code || "request_error",
          });
          if (!s.headersSent) this.json(s, 400, { error: e.message });
          else s.destroy();
        }),
      );
      this.server.requestTimeout = 120000;
      this.server.headersTimeout = 15000;
      await new Promise((r, j) => {
        this.server.once("error", j);
        this.server.listen(0, "127.0.0.1", r);
      });
      this.origin = "http://127.0.0.1:" + this.server.address().port;
      this.url = this.origin + "/?token=" + this.token;
      save(path.join(this.profile, "runtime.json"), {
        pid: process.pid,
        port: this.server.address().port,
        token: this.token,
        origin: this.origin,
        profile: this.profile,
      });
      this.bridge.on("item", (item) => {
        if (
          item.type === "open" &&
          this.bridge.peers[item.peerId]?.allowRemoteOpen
        )
          this.acceptOpen(item.id).catch(() => {});
      });
      this.bridge.start();
      return this;
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  json(res, status, value) {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
  }
  auth(req, u) {
    const candidates = [
      u.searchParams.get("token"),
      req.headers["x-file-bridge-token"],
      req.headers.cookie?.match(
        /(?:^|; )fileBridgeSession=([a-f0-9]{64})(?:;|$)/,
      )?.[1],
    ];
    return candidates.some(
      (v) =>
        typeof v === "string" &&
        v.length === this.token.length &&
        crypto.timingSafeEqual(Buffer.from(v), Buffer.from(this.token)),
    );
  }
  async body(req) {
    let value = "";
    for await (const b of req) {
      value += b;
      if (Buffer.byteLength(value) > 262144) throw Error("Request too large");
    }
    return value ? JSON.parse(value) : {};
  }
  async acceptOpen(id) {
    const item = this.bridge.items.find(
      (x) => x.id === id && x.type === "open",
    );
    if (!item || item.status !== "pending")
      throw Error("Unknown or already handled request");
    item.status = "accepted";
    item.pendingDesktopOpen = Date.now() - (this.desktopSeenAt || 0) < 10000;
    save(this.bridge.file("items.json"), this.bridge.items);
    this.bridge.log("browser_request_accepted", {
      peerId: item.peerId,
      jobId: id,
    });
    if (item.pendingDesktopOpen) return { ok: true, queuedForDesktop: true };
    try {
      const child = this.openBrowser(this.url);
      if (child?.on)
        child.on("error", () => this.bridge.log("browser_open_failed"));
      return { ok: true };
    } catch (e) {
      this.bridge.log("browser_open_failed");
      throw e;
    }
  }
  async api(req, res) {
    const u = new URL(req.url, this.origin);
    if (
      req.headers.host !== new URL(this.origin).host ||
      (req.headers.origin && req.headers.origin !== this.origin)
    )
      return this.json(res, 403, { error: "Foreign origin denied" });
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!this.auth(req, u))
      return this.json(res, 401, {
        error: "Open this device dashboard from its tray icon",
      });
    if (this.stopping || this.shutdownRequested)
      return this.json(res, 503, { error: "File Bridge is stopping" });
    if (
      !["GET", "HEAD"].includes(req.method) &&
      req.headers["x-file-bridge-request"] !== "1"
    )
      return this.json(res, 403, { error: "Request header required" });
    if (
      req.method === "GET" &&
      ["/", "/app.js", "/style.css"].includes(u.pathname)
    ) {
      if (u.pathname === "/")
        res.setHeader(
          "Set-Cookie",
          "fileBridgeSession=" +
            this.token +
            "; HttpOnly; SameSite=Strict; Path=/",
        );
      const filename = u.pathname === "/" ? "index.html" : u.pathname.slice(1);
      res.writeHead(200, {
        "Content-Type": filename.endsWith(".js")
          ? "text/javascript"
          : filename.endsWith(".css")
            ? "text/css"
            : "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
      return res.end(fs.readFileSync(path.join(__dirname, "public", filename)));
    }
    if (req.method === "GET" && u.pathname === "/api/status") {
      const status = this.bridge.status();
      let registered = false;
      try {
        registered = fs.existsSync(startupPath(this.profile));
      } catch {}
      return this.json(res, 200, {
        ...status,
        startupRegistered: registered,
        desktopConfigured: !!load(
          this.bridge.file("desktop-launch.json"),
          null,
        ),
      });
    }
    if (req.method === "GET" && u.pathname === "/api/logs") {
      const f = this.bridge.file("logs/events.jsonl");
      const lines = fs.existsSync(f)
        ? fs
            .readFileSync(f, "utf8")
            .trim()
            .split("\n")
            .slice(-100)
            .map((x) => JSON.parse(x))
        : [];
      return this.json(res, 200, { events: lines });
    }
    if (req.method === "GET" && u.pathname.startsWith("/api/download/")) {
      const id = u.pathname.slice("/api/download/".length);
      const item = this.bridge.items.find(
        (x) => x.id === id && x.type === "file",
      );
      if (!item) return this.json(res, 404, { error: "No such file" });
      const full = path.resolve(this.profile, item.file);
      if (!full.startsWith(this.profile + path.sep))
        throw Error("Invalid file path");
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
      });
      const stream = fs.createReadStream(full);
      stream.on("error", () => res.destroy());
      stream.pipe(res);
      return;
    }
    if (req.method === "POST" && u.pathname === "/api/file") {
      const peerId = u.searchParams.get("peerId");
      if (!this.bridge.peers[peerId]?.enabled)
        throw Error("Choose a paired peer");
      const declared = Number(req.headers["content-length"] || 0);
      if (declared > MAX_FILE) throw Error("Maximum file size is 1 GiB");
      const temp = this.bridge.file("uploads/" + crypto.randomUUID() + ".part");
      directory(path.dirname(temp));
      let bytes = 0;
      try {
        const fd = fs.openSync(temp, "wx", 0o600);
        try {
          for await (const b of req) {
            bytes += b.length;
            if (bytes > MAX_FILE) throw Error("Maximum file size is 1 GiB");
            fs.writeSync(fd, b);
          }
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        const value = this.bridge.enqueue(peerId, "file", {
          temp,
          name: decodeURIComponent(req.headers["x-file-name"] || "file.bin"),
          size: bytes,
          digest: await digest(temp),
          mime: String(
            req.headers["content-type"] || "application/octet-stream",
          ),
        });
        return this.json(res, 201, value);
      } finally {
        fs.rmSync(temp, { force: true });
      }
    }
    if (req.method !== "POST")
      return this.json(res, 404, { error: "Not found" });
    const data = await this.body(req);
    let value = { ok: true };
    switch (u.pathname) {
      case "/api/pair/create":
        value = await this.bridge.pairing.offer();
        break;
      case "/api/pair/cancel":
        this.bridge.pairing.cancelOffer();
        break;
      case "/api/pair/join":
        value = await this.bridge.pairing.join(data.code);
        break;
      case "/api/text":
        value = this.bridge.enqueue(data.peerId, "text", { text: data.text });
        break;
      case "/api/open/request":
        value = this.bridge.enqueue(data.peerId, "open");
        break;
      case "/api/open/accept":
        value = await this.acceptOpen(data.id);
        break;
      case "/api/open/reject": {
        const item = this.bridge.items.find(
          (x) =>
            x.id === data.id && x.type === "open" && x.status === "pending",
        );
        if (!item) throw Error("No pending request");
        item.status = "rejected";
        save(this.bridge.file("items.json"), this.bridge.items);
        break;
      }
      case "/api/peer": {
        const p = this.bridge.peers[data.peerId];
        if (!p) throw Error("Unknown peer");
        if (typeof data.allowRemoteOpen === "boolean")
          p.allowRemoteOpen = data.allowRemoteOpen;
        save(this.bridge.file("peers.json"), this.bridge.peers);
        break;
      }
      case "/api/revoke":
        this.bridge.revoke(data.peerId);
        break;
      case "/api/settings": {
        if (typeof data.openOnStartup === "boolean")
          this.bridge.settings.openOnStartup = data.openOnStartup;
        if (typeof data.loginStartup === "boolean") {
          const options = load(this.bridge.file("desktop-launch.json"), null);
          if (!options)
            throw Error("Start the desktop app before enabling login startup");
          applyStartup(
            { ...options, profile: this.profile },
            data.loginStartup,
          );
          this.bridge.settings.loginStartup = data.loginStartup;
        }
        save(this.bridge.file("settings.json"), this.bridge.settings);
        this.bridge.log("settings_saved");
        break;
      }
      case "/api/desktop/poll": {
        this.desktopSeenAt = Date.now();
        const pending = this.bridge.items.filter(
          (x) =>
            x.type === "open" &&
            x.status === "accepted" &&
            x.pendingDesktopOpen,
        );
        const requestIds = [];
        for (const item of pending) {
          item.pendingDesktopOpen = false;
          if (Date.now() - item.createdAt < 300000) requestIds.push(item.id);
        }
        if (pending.length)
          save(this.bridge.file("items.json"), this.bridge.items);
        value = { requestIds };
        break;
      }
      case "/api/desktop-config": {
        if (
          typeof data.executable !== "string" ||
          !path.isAbsolute(data.executable) ||
          typeof data.appRoot !== "string" ||
          !path.isAbsolute(data.appRoot)
        )
          throw Error("Invalid desktop launch paths");
        save(this.bridge.file("desktop-launch.json"), {
          executable: data.executable,
          appRoot: data.appRoot,
        });
        break;
      }
      case "/api/shutdown":
        this.shutdownRequested = true;
        this.json(res, 200, { ok: true });
        process.send?.({ type: "intentional-stop" });
        setImmediate(() => this.stop());
        return;
      default:
        return this.json(res, 404, { error: "Not found" });
    }
    return this.json(res, 200, value);
  }
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.bridge) await this.bridge.stop();
    if (this.server)
      await new Promise((r) => {
        this.server.close(r);
        this.server.closeAllConnections();
      });
    try {
      const runtime = load(path.join(this.profile, "runtime.json"), null);
      if (runtime?.pid === process.pid)
        fs.rmSync(path.join(this.profile, "runtime.json"), { force: true });
      if (load(path.join(this.lock, "owner.json"), {})?.pid === process.pid)
        fs.rmSync(this.lock, { recursive: true });
    } catch {}
    this.onStopped?.();
  }
}
module.exports = { App };
