"use strict";
(() => {
  const $ = (s) => document.querySelector(s),
    CHUNK = 1024 * 1024,
    MAX = 1024 * 1024 * 1024;
  let db,
    jobs = [],
    running = false,
    workerTimer,
    pollTimer,
    pollFailures = 0,
    view = "recent",
    selected = null,
    selectionBusy = false,
    closed = false,
    refreshGeneration = 0,
    storageReady = false;
  let identity;
  try { identity = JSON.parse(localStorage.getItem("file-bridge-source")); } catch {}
  if (!identity || !/^[a-f0-9-]{36}$/i.test(identity.id) || typeof identity.name !== "string") {
    const id = crypto.randomUUID();
    identity = { id, name: "主机 " + id.slice(0, 6).toUpperCase() };
  }
  let identitySaved = false;
  function saveIdentity() {
    try {
      localStorage.setItem("file-bridge-source", JSON.stringify(identity));
      identitySaved = true;
    } catch {
      identitySaved = false;
      tell("来源名称无法保存，请允许此网站使用浏览器存储");
    }
  }
  saveIdentity();
  $("#sourceName").value = identity.name;
  $("#sourceForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#sourceName").value.trim();
    if (!name || [...name].length > 40 || /[\x00-\x1f\x7f]/.test(name)) {
      tell("请输入 1–40 字的来源名称"); return;
    }
    identity = { id: identity.id, name };
    saveIdentity();
    if (identitySaved) tell("来源名称已保存，新发送的内容将使用“" + name + "”");
  });
  const sourceLabel = (s) => s ? s.name + " · " + s.id.slice(0, 6).toUpperCase() : "未标记来源（旧记录）";
  $("#sourceFilter").addEventListener("change", () => refresh());
  const attempts = new Map();
  const esc = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const size = (n) =>
    n >= 1048576
      ? (n / 1048576).toFixed(1) + " MB"
      : (n / 1024).toFixed(1) + " KB";
  function tell(s) {
    $("#notice").textContent = s;
  }
  function connection(online) {
    $("#connection").textContent = online
      ? "网页已连接"
      : "连接中，稍后自动继续";
    $("#connection").className = online ? "online" : "offline";
  }
  async function api(route, { data, raw, method, timeout = 45000 } = {}) {
    const c = new AbortController(),
      timer = setTimeout(() => c.abort(), timeout);
    try {
      const r = await fetch("/api/" + route, {
        method: method || (data !== undefined ? "POST" : "GET"),
        headers: {
          "x-file-bridge-request": "1",
          ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: raw ?? (data !== undefined ? JSON.stringify(data) : undefined),
        signal: c.signal,
      });
      let v;
      try {
        v = await r.json();
      } catch {
        throw Error("连接中断，正在等待恢复");
      }
      if (!r.ok)
        throw Object.assign(Error(v.error || "发送失败"), { status: r.status });
      return v;
    } finally {
      clearTimeout(timer);
    }
  }
  function transaction(mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction("jobs", mode);
      let value;
      try {
        value = fn(t.objectStore("jobs"));
      } catch (e) {
        reject(e);
        return;
      }
      t.oncomplete = () => resolve(value?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || Error("保存失败"));
    });
  }
  const put = (j) => transaction("readwrite", (s) => s.put(j));
  async function remove(id) {
    await transaction("readwrite", (s) => s.delete(id));
    jobs = jobs.filter((j) => j.id !== id);
    attempts.delete(id);
    render();
  }
  function render() {
    const states = {
      queued: "等待发送",
      hashing: "正在检查文件",
      sending: "正在发送",
      verifying: "正在确认保存",
      done: "主机已保存",
      waiting: "等待恢复后继续",
      error: "需要处理",
    };
    $("#queue").innerHTML = jobs.length
      ? jobs
          .slice()
          .reverse()
          .map(
            (j) =>
              `<div class="entry"><div class="row"><strong>${esc(j.type === "text" ? j.text.slice(0, 70) : j.name)}</strong><span class="state ${["waiting", "error"].includes(j.state) ? "waiting" : ""}">${states[j.state] || states.queued}</span></div>${j.type === "file" ? `<p class="muted">${size(j.size)} · ${Math.floor((j.progress || 0) * 100)}%</p>` : ""}<p class="muted">来源：${esc(sourceLabel(j.source))}</p>${j.error ? `<p class="muted">${esc(j.error)}</p>` : ""}${!["done", "error"].includes(j.state) ? `<progress class="progress" max="100" value="${Math.floor((j.progress || 0) * 100)}"></progress>` : ""}${["error", "waiting"].includes(j.state) ? `<p><button class="secondary" data-retry="${j.id}">继续发送</button> <button class="secondary" data-remove="${j.id}">移除任务</button></p>` : ""}</div>`,
          )
          .join("")
      : '<p class="empty">还没有待发送的内容</p>';
  }
  async function digest(bytes) {
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(d), (n) =>
      n.toString(16).padStart(2, "0"),
    ).join("");
  }
  async function send(j) {
    if (j.type === "text") {
      j.state = "sending";
      render();
      await api("text", { data: { id: j.id, text: j.text, source: j.source || null } });
      return;
    }
    if (!j.file)
      throw Object.assign(Error("原文件未保留，请重新选择"), { status: 400 });
    if (!crypto.subtle)
      throw Object.assign(Error("请通过 HTTPS 网址打开网页后发送文件"), {
        status: 400,
      });
    if (!j.blocks) {
      j.state = "hashing";
      render();
      const blocks = [];
      for (let i = 0; i < j.file.size; i += CHUNK) {
        blocks.push(
          await digest(await j.file.slice(i, i + CHUNK).arrayBuffer()),
        );
        j.progress = ((i + CHUNK) / Math.max(j.file.size, 1)) * 0.05;
        render();
      }
      j.blocks = blocks;
      j.manifest = await digest(new TextEncoder().encode(blocks.join("")));
      await put(j);
    }
    j.state = "sending";
    render();
    const s = await api("uploads", {
      data: {
        id: j.uploadId || j.id,
        source: j.source || null,
        name: j.name,
        size: j.size,
        mime: j.mime,
        blocks: j.blocks,
        manifest: j.manifest,
      },
    });
    j.uploadId = s.id;
    await put(j);
    if (s.state === "completed" && s.item) return;
    const present = new Set(s.present);
    for (let i = 0; i < j.blocks.length; i++) {
      if (!present.has(i))
        await api("uploads/" + j.uploadId + "/chunks/" + i, {
          method: "PUT",
          raw: await j.file.slice(i * CHUNK, (i + 1) * CHUNK).arrayBuffer(),
        });
      j.progress = Math.min(
        0.95,
        ((i + 1) / Math.max(j.blocks.length, 1)) * 0.95,
      );
      render();
    }
    j.state = "verifying";
    j.progress = 0.98;
    render();
    await api("uploads/" + j.uploadId + "/complete", {
      data: {},
      timeout: 300000,
    });
  }
  async function work() {
    if (running || closed || !db) return;
    clearTimeout(workerTimer);
    const j = jobs.find((x) =>
      ["queued", "waiting", "sending", "hashing", "verifying"].includes(
        x.state,
      ),
    );
    if (!j) return;
    running = true;
    let wait = 0;
    try {
      await send(j);
      j.state = "done";
      j.progress = 1;
      delete j.file;
      delete j.blocks;
      delete j.error;
      await put(j);
      attempts.delete(j.id);
      tell("已收到主机保存确认");
      connection(true);
      for (const old of jobs.filter((x) => x.state === "done").slice(0, -20))
        await remove(old.id);
      await refresh();
    } catch (e) {
      const fatal = [400, 401, 403, 413, 415].includes(e.status);
      j.state = fatal ? "error" : "waiting";
      j.error = e.message || "网络中断，恢复后会继续";
      await put(j).catch(() => tell("浏览器存储空间不足，请保留当前页面"));
      wait = fatal ? 0 : Math.min((attempts.get(j.id) || 0) + 1, 30);
      attempts.set(j.id, wait);
      if (!fatal) connection(false);
    } finally {
      running = false;
      render();
      workerTimer = setTimeout(work, wait * 1000);
    }
  }
  async function enqueue(j) {
    if (!identitySaved) throw Error("请先允许网站存储并保存来源名称");
    if (!db || !storageReady)
      throw Error("当前浏览器未提供持久存储，请允许网站存储后重试");
    j.source = { ...identity };
    await put(j);
    jobs.push(j);
    render();
    tell("内容已保存在当前浏览器，正在发送");
    work();
  }
  async function refresh(schedule = true) {
    const generation = ++refreshGeneration;
    clearTimeout(pollTimer);
    try {
      const r = await api(view === "recent" ? "items" : "archives", {
        timeout: 10000,
      });
      if (generation !== refreshGeneration) return;
      connection(true);
      pollFailures = 0;
      const filter = $("#sourceFilter"), chosen = filter.value;
      const sources = new Map();
      for (const s of r.sources || r.items.map(i => i.source)) sources.set(s?.id || "legacy", s);
      // Keep a selected source even when it has no records in the other tab.
      const previous = filter.selectedOptions[0]?.textContent;
      if (chosen !== "*" && !sources.has(chosen)) sources.set(chosen, { label: previous });
      filter.innerHTML = '<option value="*">全部来源</option>' + [...sources].map(([id, s]) =>
        `<option value="${esc(id)}">${esc(s?.label || sourceLabel(s))}</option>`).join("");
      filter.value = chosen;
      const visible = r.items.filter(i => chosen === "*" || (i.source?.id || "legacy") === chosen);
      $("#sourceCount").textContent = visible.length + " 条 / 共 " + r.items.length + " 条";
      $("#items").innerHTML = visible.length
        ? visible
            .map(
              (i) =>
                `<div class="item" data-id="${esc(i.id)}"><span class="source-badge">${esc(sourceLabel(i.source))}</span>${i.kind === "text" ? `<pre>${esc(i.text)}</pre>` : `<p><a href="${esc(i.download)}">下载：${esc(i.name)}</a> <span class="muted">${size(i.size)}${i.verified ? " · 已完整保存" : ""}</span></p>${/^image\/(png|jpeg|gif|webp)$/.test(i.mime) && view === "recent" ? `<img src="${esc(i.download.replace("/download/", "/preview/"))}" alt="${esc(i.name)}" loading="lazy">` : ""}`}<div class="row"><time>${new Date(i.createdAt).toLocaleString()}</time>${view === "recent" ? `<button class="secondary" data-archive="${esc(i.id)}" ${i.archived ? "disabled" : ""}>${i.archived ? "已归档" : "归档到主机"}</button>` : ""}</div></div>`,
            )
            .join("")
        : `<p class="empty">${chosen !== "*" ? "此来源暂无内容" : view === "recent" ? "还没有收到内容" : "还没有归档内容"}</p>`;
    } catch (e) {
      if (generation !== refreshGeneration) return;
      pollFailures++;
      connection(false);
      if ([401, 403].includes(e.status)) tell(e.message);
    } finally {
      if (schedule && !closed && generation === refreshGeneration)
        pollTimer = setTimeout(
          refresh,
          pollFailures ? Math.min(pollFailures, 30) * 1000 : 4000,
        );
    }
  }
  $("#textForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#text").value.trim();
    if (!text) return;
    if (new TextEncoder().encode(text).byteLength > 1024 * 1024) {
      tell("文字最多 1 MB，请分段发送；原文仍保留在输入框中");
      return;
    }
    $("#sendText").disabled = true;
    try {
      await enqueue({
        id: crypto.randomUUID(),
        type: "text",
        text,
        state: "queued",
        createdAt: Date.now(),
      });
      $("#text").value = "";
    } catch (e) {
      tell(e.message);
    } finally {
      $("#sendText").disabled = false;
    }
  });
  function select(f) {
    if (selectionBusy) return;
    selected = f || null;
    $("#fileName").textContent = f
      ? f.name + " · " + size(f.size)
      : "未选择文件";
    $("#sendFile").disabled = !f || !storageReady;
  }
  $("#file").addEventListener("change", () => select($("#file").files[0]));
  for (const type of ["dragenter", "dragover"])
    $("#dropZone").addEventListener(type, (e) => {
      e.preventDefault();
      $("#dropZone").classList.add("dragover");
    });
  for (const type of ["dragleave", "drop"])
    $("#dropZone").addEventListener(type, (e) => {
      e.preventDefault();
      $("#dropZone").classList.remove("dragover");
      if (type === "drop") select(e.dataTransfer.files[0]);
    });
  $("#sendFile").addEventListener("click", async () => {
    const f = selected;
    if (!f || selectionBusy) return;
    selectionBusy = true;
    $("#sendFile").disabled = true;
    try {
      if (f.size > MAX) throw Error("单个文件最大 1 GB");
      await enqueue({
        id: crypto.randomUUID(),
        type: "file",
        file: f,
        name: f.name,
        size: f.size,
        mime: f.type || "application/octet-stream",
        state: "queued",
        progress: 0,
        createdAt: Date.now(),
      });
      selected = null;
      $("#file").value = "";
      $("#fileName").textContent = "未选择文件";
    } catch (e) {
      tell(
        e.name === "QuotaExceededError"
          ? "浏览器空间不足，请释放空间后再发送"
          : e.message,
      );
    } finally {
      selectionBusy = false;
      $("#sendFile").disabled = !selected;
    }
  });
  $("#queue").addEventListener("click", async (e) => {
    const retry = e.target.closest("[data-retry]"),
      drop = e.target.closest("[data-remove]");
    if (retry) {
      const j = jobs.find((x) => x.id === retry.dataset.retry);
      if (j) {
        j.state = "queued";
        delete j.error;
        attempts.delete(j.id);
        await put(j);
        render();
        work();
      }
    }
    if (drop && !running) await remove(drop.dataset.remove);
    else if (drop) tell("正在发送，请等本次请求结束后再移除");
  });
  $("#items").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-archive]");
    if (!b) return;
    b.disabled = true;
    try {
      await api("archive/" + b.dataset.archive, { data: {} });
      await refresh();
    } catch (e) {
      b.disabled = false;
      tell(e.message);
    }
  });
  for (const [id, next] of [
    ["#recentTab", "recent"],
    ["#archiveTab", "archive"],
  ])
    $(id).addEventListener("click", () => {
      view = next;
      for (const [button, name] of [
        ["#recentTab", "recent"],
        ["#archiveTab", "archive"],
      ]) {
        $(button).classList.toggle("active", name === view);
        $(button).setAttribute("aria-pressed", String(name === view));
      }
      $("#receivedTitle").textContent =
        view === "recent" ? "最近收到" : "已归档";
      $("#retention").textContent =
        view === "recent"
          ? "最近内容保留 24 小时，归档后保存在主机上。"
          : "归档内容保存在主机上，不会随最近内容过期。";
      refresh();
    });
  window.addEventListener("online", () => {
    attempts.clear();
    pollFailures = 0;
    refresh();
    work();
  });
  window.addEventListener("pagehide", () => {
    closed = true;
    clearTimeout(pollTimer);
    clearTimeout(workerTimer);
  });
  window.addEventListener("pageshow", () => {
    closed = false;
    refresh();
    work();
  });
  (async () => {
    try {
      if (!window.indexedDB) throw Error("此浏览器未启用网站存储");
      db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("file-bridge-single-host", 1);
        r.onupgradeneeded = () =>
          r.result.createObjectStore("jobs", { keyPath: "id" });
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      jobs = await transaction("readonly", (s) => s.getAll());
      jobs.sort((a, b) => a.createdAt - b.createdAt);
      for (const j of jobs)
        if (!["done", "error"].includes(j.state)) {
          j.state = "queued";
          delete j.error;
        }
      render();
      storageReady = true;
      $("#sendText").disabled = false;
      $("#sendFile").disabled = !selected;
      navigator.storage?.persist?.().catch(() => {});
      work();
    } catch (e) {
      tell("待发送存储未就绪：" + e.message);
      $("#sendText").disabled = true;
      $("#sendFile").disabled = true;
    }
    refresh();
  })();
})();
