"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  https = require("node:https"),
  crypto = require("node:crypto");
const { HttpsProxyAgent } = require("https-proxy-agent");
const root = path.resolve(__dirname, ".."),
  args = process.argv.slice(2),
  arg = (n, f) => (args.includes(n) ? args[args.indexOf(n) + 1] : f),
  platform = arg("--platform", process.platform),
  arch = arg("--arch", process.arch),
  version = fs.existsSync(path.join(root, "node_modules/electron/package.json"))
    ? JSON.parse(
        fs.readFileSync(path.join(root, "node_modules/electron/package.json")),
      ).version
    : JSON.parse(fs.readFileSync(path.join(root, "docs/RUNTIME-SOURCES.json")))
        .artifacts[0].version,
  name = `electron-v${version}-${platform}-${arch}.zip`,
  checks = fs.existsSync(
    path.join(root, "node_modules/electron/checksums.json"),
  )
    ? JSON.parse(
        fs.readFileSync(
          path.join(root, "node_modules/electron/checksums.json"),
        ),
      )
    : Object.fromEntries(
        JSON.parse(
          fs.readFileSync(path.join(root, "docs/RUNTIME-SOURCES.json")),
        ).artifacts.map((x) => [x.filename, x.sha256]),
      ),
  expected = checks[name],
  cache = path.resolve(arg("--cache", path.join(root, "..", "runtime-cache"))),
  out = path.resolve(
    arg("--out", path.join(root, "node_modules/electron/dist")),
  );
if (!["linux", "win32"].includes(platform) || !expected)
  throw Error("Unsupported verified runtime");
fs.mkdirSync(cache, { recursive: true });
const zip = path.join(cache, name),
  proxy = process.env.HTTPS_PROXY || process.env.https_proxy,
  agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
const hash = (p) =>
  new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256"),
      s = fs.createReadStream(p);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
function request(url, headers, signal, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(Error("Too many redirects"));
    const req = https.get(url, { agent, headers, signal }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const next = new URL(res.headers.location, url).href;
        res.resume();
        return request(next, headers, signal, depth + 1).then(resolve, reject);
      }
      resolve(res);
    });
    req.setTimeout(15000, () => req.destroy(Error("Download socket timeout")));
    req.on("error", reject);
  });
}
async function download(url) {
  const probe = await request(url, { Range: "bytes=0-0" });
  const range = probe.headers["content-range"];
  probe.resume();
  if (probe.statusCode !== 206 || !range)
    throw Error("Source does not support parallel range download");
  const size = Number(range.split("/")[1]);
  if (!Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024 * 1024)
    throw Error("Invalid artifact size");
  const controller = new AbortController(),
    start = Date.now(),
    parts = [],
    partSize = Math.ceil(size / 4);
  let bytes = 0;
  const timer = setInterval(() => {
    const seconds = (Date.now() - start) / 1000;
    if (seconds >= 10 && bytes / seconds < 819200)
      controller.abort(Error("Below 800 KiB/s; switching source"));
  }, 1000);
  const tasks = Array.from({ length: 4 }, async (_, i) => {
    const first = i * partSize,
      last = Math.min(size - 1, first + partSize - 1),
      dest = zip + ".part" + i;
    parts[i] = dest;
    const res = await request(
      url,
      { Range: `bytes=${first}-${last}` },
      controller.signal,
    );
    if (res.statusCode !== 206) throw Error("Source ignored range");
    const fd = fs.openSync(dest, "w");
    let count = 0;
    try {
      for await (const chunk of res) {
        fs.writeSync(fd, chunk);
        bytes += chunk.length;
        count += chunk.length;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (count !== last - first + 1) throw Error("Truncated artifact range");
  });
  try {
    await Promise.all(tasks);
    const fd = fs.openSync(zip, "w");
    try {
      for (const p of parts) fs.writeSync(fd, fs.readFileSync(p));
    } finally {
      fs.closeSync(fd);
    }
    if ((await hash(zip)) !== expected)
      throw Error("Official runtime checksum mismatch");
    console.log(
      `Verified runtime: ${(size / 1048576).toFixed(1)} MiB at ${(size / ((Date.now() - start) / 1000) / 1048576).toFixed(2)} MiB/s`,
    );
  } finally {
    clearInterval(timer);
    controller.abort();
    await Promise.allSettled(tasks);
    for (const p of parts) if (p) fs.rmSync(p, { force: true });
  }
}
(async () => {
  if (!fs.existsSync(zip) || (await hash(zip)) !== expected) {
    const sources = [
      `https://github.com/electron/electron/releases/download/v${version}/${name}`,
      `https://npmmirror.com/mirrors/electron/${version}/${name}`,
      `https://registry.npmmirror.com/-/binary/electron/${version}/${name}`,
    ];
    let done = false;
    for (const source of sources) {
      try {
        console.log("Runtime source: " + new URL(source).hostname);
        await download(source);
        done = true;
        break;
      } catch (e) {
        console.error(e.message);
      }
    }
    if (!done) throw Error("No trusted source completed at the required speed");
  } else console.log("Using checksum-verified cached runtime");
  fs.mkdirSync(out, { recursive: true });
  let extractor;
  try {
    extractor = (await import("@electron-internal/extract-zip")).default;
  } catch {}
  if (extractor) await extractor(zip, { dir: out });
  else {
    const cp = require("node:child_process");
    let result;
    if (process.platform === "win32") {
      const quote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
      const script =
        "Expand-Archive -LiteralPath " +
        quote(zip) +
        " -DestinationPath " +
        quote(out) +
        " -Force";
      result = cp.spawnSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(script, "utf16le").toString("base64"),
        ],
        { stdio: "inherit", windowsHide: true },
      );
    } else
      result = cp.spawnSync("unzip", ["-q", "-o", zip, "-d", out], {
        stdio: "inherit",
      });
    if (result.error || result.status !== 0)
      throw Error("Verified runtime extraction failed");
  }
  const exe = platform === "win32" ? "electron.exe" : "electron";
  if (
    platform === process.platform &&
    out === path.join(root, "node_modules/electron/dist")
  )
    fs.writeFileSync(path.join(root, "node_modules/electron/path.txt"), exe);
  console.log("Runtime ready: " + path.join(out, exe));
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
