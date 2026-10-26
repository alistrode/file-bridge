"use strict";
// Run as the logged-in Windows user against an isolated, already running Chromium CDP endpoint.
const fs = require("node:fs"),
  path = require("node:path"),
  http = require("node:http"),
  crypto = require("node:crypto"),
  assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."),
  out = path.join(root, "artifacts/windows-browser"),
  checks = [];
fs.mkdirSync(out, { recursive: true });
const url = fs
    .readFileSync(path.join(root, "var/current-url.txt"), "utf8")
    .trim(),
  port = Number(process.argv[2] || 18892);
function record(s) {
  checks.push(s);
  fs.appendFileSync(path.join(out, "progress.log"), s + "\n");
  console.log(s);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function descriptor() {
  return new Promise((resolve, reject) => {
    const r = http.get(
      "http://127.0.0.1:" + port + "/json/version",
      { timeout: 10000 },
      (res) => {
        let s = "";
        res.on("data", (b) => (s += b));
        res.on("end", () => {
          try {
            resolve(JSON.parse(s));
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    r.on("error", reject);
    r.on("timeout", () =>
      r.destroy(Error("Browser testing interface did not respond")),
    );
  });
}
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          m.error
            ? p.reject(Error(p.method + ": " + m.error.message))
            : p.resolve(m.result);
        }
      } else for (const listener of this.listeners) listener(m);
    });
  }
  call(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id,
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(Error(method + " timed out"));
        }, 45000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.ws.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {}),
        }),
      );
    });
  }
  async page(width, height, mobile = false) {
    const context = (
      await this.call("Target.createBrowserContext", { disposeOnDetach: true })
    ).browserContextId;
    const target = (
      await this.call("Target.createTarget", {
        url: "about:blank",
        browserContextId: context,
      })
    ).targetId;
    const sessionId = (
      await this.call("Target.attachToTarget", {
        targetId: target,
        flatten: true,
      })
    ).sessionId;
    const page = { sessionId, context };
    page.call = (m, p) => this.call(m, p, sessionId);
    page.eval = async (expression) => {
      const v = await page.call("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
      });
      if (v.exceptionDetails)
        throw Error(
          v.exceptionDetails.exception?.description || v.exceptionDetails.text,
        );
      return v.result.value;
    };
    page.until = async (expression, timeout = 60000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        try {
          const v = await page.eval(expression);
          if (v) return v;
        } catch {}
        await sleep(300);
      }
      throw Error("Browser condition timed out: " + expression.slice(0, 160));
    };
    page.click = (selector) =>
      page.eval(
        "document.querySelector(" + JSON.stringify(selector) + ").click()",
      );
    page.fill = (selector, value) =>
      page.eval(
        "document.querySelector(" +
          JSON.stringify(selector) +
          ").value=" +
          JSON.stringify(value),
      );
    await page.call("Page.enable");
    await page.call("Runtime.enable");
    await page.call("Network.enable");
    await page.call("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    await page.call("Emulation.setTimezoneOverride", {
      timezoneId: "Asia/Shanghai",
    });
    await page.call("Emulation.setLocaleOverride", { locale: "zh-CN" });
    if (mobile)
      await page.call("Emulation.setTouchEmulationEnabled", { enabled: true });
    await page.call("Page.navigate", { url });
    await page.until(
      'document.querySelector("h1")?.textContent==="打开网页，就能传。"',
      90000,
    );
    await page.until(
      'document.readyState==="complete"&&document.querySelector("#sendText")?.disabled===false',
    );
    page.reload = async () => {
      await page.eval("window.__fbBeforeReload=true");
      await page.call("Page.reload");
      await page.until(
        'document.readyState==="complete"&&!window.__fbBeforeReload&&document.querySelector("#sendText")?.disabled===false',
        90000,
      );
    };
    return page;
  }
  async screenshot(p, name) {
    const metrics = await p.call("Page.getLayoutMetrics"),
      size = metrics.cssContentSize || metrics.contentSize;
    const image = await p.call("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
    });
    fs.writeFileSync(path.join(out, name), Buffer.from(image.data, "base64"));
  }
}
(async () => {
  if (process.platform !== "win32")
    throw Error("Use browser-functional.py for local Linux validation");
  const d = await descriptor(),
    ws = new WebSocket(d.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  const client = new CDP(ws),
    contexts = [],
    errors = [];
  try {
    const a = await client.page(1280, 1000),
      b = await client.page(390, 844, true);
    contexts.push(a.context, b.context);
    client.listeners.push((m) => {
      if (m.method === "Runtime.exceptionThrown")
        errors.push(
          m.params.exceptionDetails.exception?.description ||
            m.params.exceptionDetails.text,
        );
    });
    assert.equal(
      await a.eval(
        'document.querySelectorAll("#pairCode,#peers,#target").length',
      ),
      0,
    );
    await a.until(
      'document.querySelector("#connection")?.textContent==="网页已连接"',
    );
    record(
      "Actual Windows browsers open the same public HTTPS website without pairing",
    );
    const stamp = crypto.randomBytes(3).toString("hex"),
      textA = "离线文字：刷新后继续发送。" + stamp,
      textB = "手机页面：同一个网址，无需连接设备。" + stamp;
    await a.call("Network.emulateNetworkConditions", {
      offline: true,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await a.fill("#text", textA);
    await a.click("#sendText");
    await a.until(
      'document.querySelector("#queue")?.textContent.includes("等待恢复后继续")',
    );
    await a.call("Network.emulateNetworkConditions", {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await a.reload();
    await b.until(
      'document.querySelector("#items")?.textContent.includes(' +
        JSON.stringify(textA) +
        ")",
    );
    record(
      "Offline text is durable and delivered after the Windows page reloads",
    );
    await b.fill("#text", textB);
    await b.click("#sendText");
    await a.until(
      'document.querySelector("#items")?.textContent.includes(' +
        JSON.stringify(textB) +
        ")",
    );
    record("Independent mobile viewport sends text back through the same host");
    let zero = 0,
      blocked = false,
      block = true;
    client.listeners.push((m) => {
      if (m.sessionId !== a.sessionId) return;
      if (
        m.method === "Network.requestWillBeSent" &&
        /\/api\/uploads\/[^/]+\/chunks\/0$/.test(m.params.request.url) &&
        m.params.request.method === "PUT"
      )
        zero++;
      if (m.method === "Fetch.requestPaused") {
        if (block) {
          blocked = true;
          a.call("Fetch.failRequest", {
            requestId: m.params.requestId,
            errorReason: "Failed",
          }).catch(() => {});
        } else
          a.call("Fetch.continueRequest", {
            requestId: m.params.requestId,
          }).catch(() => {});
      }
    });
    await a.call("Fetch.enable", {
      patterns: [
        { urlPattern: "*/api/uploads/*/chunks/1", requestStage: "Request" },
      ],
    });
    const length = 2 * 1024 * 1024 + 123,
      name = "实机续传测试-" + stamp + ".bin";
    await a.eval(
      `(()=>{const bytes=new Uint8Array(${length});for(let i=0;i<bytes.length;i++)bytes[i]=i%251;const dt=new DataTransfer();dt.items.add(new File([bytes],${JSON.stringify(name)},{type:'application/octet-stream'}));const input=document.querySelector('#file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await a.click("#sendFile");
    const entry = `Array.from(document.querySelectorAll('#queue .entry')).find(x=>x.textContent.includes(${JSON.stringify(name)}))`;
    await a.until(entry + '?.textContent.includes("等待恢复后继续")');
    assert(blocked);
    block = false;
    await a.call("Fetch.disable");
    await a.reload();
    await a.until(entry + '?.textContent.includes("主机已保存")', 120000);
    assert.equal(zero, 1);
    record(
      "Windows file queue survives reload and resumes without retransmitting the saved first chunk",
    );
    const link = `Array.from(document.querySelectorAll('#items a')).find(x=>x.textContent===${JSON.stringify("下载：" + name)})`;
    await b.until(link);
    const file = await b.eval(
      `(async()=>{const r=await fetch((${link}).href);if(!r.ok)throw Error('Download failed');const bytes=await r.arrayBuffer();return {length:bytes.byteLength,digest:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join(''),disposition:r.headers.get('content-disposition')};})()`,
    );
    const expected = Buffer.alloc(length);
    for (let i = 0; i < length; i++) expected[i] = i % 251;
    assert.equal(file.length, length);
    assert.equal(
      file.digest,
      crypto.createHash("sha256").update(expected).digest("hex"),
    );
    assert.match(file.disposition, /^attachment;/);
    record(
      "Complete file downloaded through the public tunnel and verified byte for byte by its digest",
    );
    await a.eval(
      `(${link}).closest('.item').querySelector('[data-archive]').click()`,
    );
    await a.until(`(${link}).closest('.item').textContent.includes('已归档')`);
    await a.click("#archiveTab");
    await a.until(link);
    await a.reload();
    await a.until('document.querySelector("#archiveTab")');
    await a.click("#archiveTab");
    await a.until(link);
    await a.click("#recentTab");
    record(
      "Archived file remains available after the actual Windows page reloads",
    );
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=";
    await a.eval(
      `(()=>{const bytes=Uint8Array.from(atob('${png}'),x=>x.charCodeAt(0)),dt=new DataTransfer();dt.items.add(new File([bytes],'图片测试.png',{type:'image/png'}));const i=document.querySelector('#file');i.files=dt.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await a.click("#sendFile");
    await b.until(
      "document.querySelector('img[alt=\"图片测试.png\"]')?.naturalWidth===1",
    );
    assert(await a.eval("document.documentElement.scrollWidth<=innerWidth"));
    assert(await b.eval("document.documentElement.scrollWidth<=innerWidth"));
    assert.deepEqual(errors, []);
    record(
      "Image preview, mobile layout and browser JavaScript checks passed on Windows",
    );
    await client.screenshot(a, "single-host-windows-desktop.png");
    await client.screenshot(b, "single-host-windows-mobile.png");
    const report = {
      passed: true,
      platform: process.platform,
      user: process.env.USERNAME,
      browser: d.Browser,
      mode: process.env.FILE_BRIDGE_BROWSER_MODE || "isolated CDP browser",
      checks,
      javascript_errors: errors,
    };
    fs.writeFileSync(
      path.join(out, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    for (const browserContextId of contexts)
      await client
        .call("Target.disposeBrowserContext", { browserContextId })
        .catch(() => {});
    ws.close();
  }
})().catch((e) => {
  const report = {
    passed: false,
    platform: process.platform,
    user: process.env.USERNAME,
    error: String(e.message || e)
      .split(url)
      .join("[private website URL]"),
    checks,
  };
  fs.writeFileSync(
    path.join(out, "result.json"),
    JSON.stringify(report, null, 2),
  );
  console.error(report.error);
  process.exitCode = 1;
});
