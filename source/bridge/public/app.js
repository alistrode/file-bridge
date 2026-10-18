"use strict";
const $ = (s) => document.querySelector(s),
  esc = (s) => {
    const d = document.createElement("span");
    d.textContent = String(s);
    return d.innerHTML;
  };
let status,
  polling = false,
  expires = 0;
history.replaceState(null, "", "/");
function notice(s) {
  $("#notice").textContent = s;
}
async function api(route, body) {
  const r = await fetch("/api/" + route, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "x-file-bridge-request": "1",
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "操作失败");
  return data;
}
async function action(fn) {
  try {
    await fn();
  } catch (e) {
    notice(e.message);
  }
}
const states = {
    queued: "等待对端确认",
    delivered: "对端已保存",
    failed: "传输失败",
    cancelled: "已取消",
  },
  types = { text: "文字", file: "文件", open: "打开网页请求" };
async function refresh() {
  if (polling) return;
  polling = true;
  try {
    status = await api("status");
    $("#connection").textContent = status.brokerOnline
      ? "连接服务在线"
      : "正在自动重连 · 第 " + status.retryAttempt + " 次";
    const selected = $("#target").value;
    $("#target").innerHTML = status.peers
      .map(
        (p) =>
          `<option value="${p.id}">${esc(p.label)} · ${p.online ? "在线" : "离线"}</option>`,
      )
      .join("");
    if (status.peers.some((p) => p.id === selected))
      $("#target").value = selected;
    $("#peers").innerHTML = status.peers.length
      ? status.peers
          .map(
            (p) =>
              `<div class="entry"><strong>${esc(p.label)}</strong> · ${p.online ? "在线" : "等待自动连接"}<p class="muted">设备指纹 ${esc(p.fingerprint.slice(0, 24))}…</p><label class="toggle"><input type="checkbox" data-allow="${p.id}" ${p.allowRemoteOpen ? "checked" : ""}>允许这台设备自动打开本机 File Bridge 网页</label><button class="secondary" data-revoke="${p.id}">取消配对</button></div>`,
          )
          .join("")
      : "还没有设备，先完成一次配对。";
    $("#loginStartup").checked = status.settings.loginStartup;
    $("#loginStartup").disabled = !status.desktopConfigured;
    $("#openOnStartup").checked = status.settings.openOnStartup;
    $("#startupState").textContent = status.desktopConfigured
      ? status.startupRegistered
        ? "已注册当前账户登录自启动。"
        : "登录自启动已关闭。"
      : "请先启动桌面托盘程序，再设置登录自启动。";
    $("#jobs").innerHTML =
      status.jobs
        .slice()
        .reverse()
        .slice(0, 15)
        .map(
          (j) =>
            `<div class="entry">${esc(types[j.type])} · ${esc(states[j.state])}${j.type === "file" ? `<p class="muted">${esc(j.name)} · ${Math.floor((j.next / j.total) * 100)}%</p>` : ""}${j.error ? `<p>${esc(j.error)}</p>` : ""}</div>`,
        )
        .join("") || "还没有发送任务。";
    $("#items").innerHTML =
      status.items
        .map(
          (i) =>
            `<div class="entry"><strong>${esc(i.label)}</strong> · ${esc(types[i.type])}<p class="muted">${new Date(i.createdAt).toLocaleString()}</p>${i.type === "text" ? `<pre>${esc(i.text)}</pre>` : i.type === "file" ? `<a href="/api/download/${i.id}">${esc(i.name)} · 下载</a>` : `<p>这台已配对设备请求打开本机 File Bridge 网页。</p>${i.status === "pending" ? `<button data-accept="${i.id}">打开网页</button><button class="secondary" data-reject="${i.id}">忽略</button>` : `<p>${i.status === "accepted" ? "已接受" : "已忽略"}</p>`}`}</div>`,
        )
        .join("") || "还没有收到内容。";
  } catch (e) {
    notice(e.message);
  } finally {
    polling = false;
  }
}
$("#create").onclick = () =>
  action(async () => {
    const p = await api("pair/create", {});
    $("#code").textContent = p.code;
    expires = p.expiresAt;
    $("#offered").hidden = false;
    notice("配对码有效 5 分钟，请只分享给你要连接的设备。");
  });
$("#cancelCode").onclick = () =>
  action(async () => {
    await api("pair/cancel", {});
    $("#offered").hidden = true;
    $("#code").textContent = "";
  });
$("#copyCode").onclick = () =>
  action(async () => {
    await navigator.clipboard.writeText($("#code").textContent);
    notice("配对码已复制");
  });
$("#pair").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    $("#join").disabled = true;
    try {
      await api("pair/join", { code: $("#pairCode").value });
      $("#pairCode").value = "";
      notice("设备已配对并记住");
      await refresh();
    } finally {
      $("#join").disabled = false;
    }
  });
};
$("#textForm").onsubmit = (e) => {
  e.preventDefault();
  action(async () => {
    await api("text", { peerId: $("#target").value, text: $("#text").value });
    $("#text").value = "";
    notice("已加入发送队列；对端确认后显示已保存");
    await refresh();
  });
};
$("#sendFile").onclick = () =>
  action(async () => {
    const file = $("#file").files[0],
      peer = $("#target").value;
    if (!file || !peer) throw Error("请选择文件和接收设备");
    if (file.size > 1073741824) throw Error("单个文件不能超过 1 GiB");
    $("#sendFile").disabled = true;
    $("#upload").textContent = "正在加入发送队列…";
    try {
      const r = await fetch("/api/file?peerId=" + encodeURIComponent(peer), {
        method: "POST",
        headers: {
          "x-file-bridge-request": "1",
          "x-file-name": encodeURIComponent(file.name),
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });
      const out = await r.json();
      if (!r.ok) throw Error(out.error);
      $("#file").value = "";
      $("#upload").textContent = "已加入发送队列，断线后会自动继续。";
      await refresh();
    } finally {
      $("#sendFile").disabled = false;
    }
  });
$("#requestOpen").onclick = () =>
  action(async () => {
    await api("open/request", { peerId: $("#target").value });
    notice("请求已排队，对方可以接受或忽略。");
  });
for (const id of ["loginStartup", "openOnStartup"])
  $("#" + id).onchange = () =>
    action(async () => {
      await api("settings", { [id]: $("#" + id).checked });
      notice("偏好已保存");
      await refresh();
    });
$("#peers").onchange = (e) => {
  if (e.target.dataset.allow)
    action(() =>
      api("peer", {
        peerId: e.target.dataset.allow,
        allowRemoteOpen: e.target.checked,
      }),
    );
};
$("#peers").onclick = (e) => {
  if (e.target.dataset.revoke && confirm("取消这台设备的配对？"))
    action(async () => {
      await api("revoke", { peerId: e.target.dataset.revoke });
      await refresh();
    });
};
$("#items").onclick = (e) => {
  const id = e.target.dataset.accept || e.target.dataset.reject;
  if (id)
    action(async () => {
      await api(e.target.dataset.accept ? "open/accept" : "open/reject", {
        id,
      });
      await refresh();
    });
};
$("#refreshLogs").onclick = () =>
  action(async () => {
    $("#logs").textContent = (await api("logs")).events
      .map((e) => JSON.stringify(e))
      .join("\n");
  });
setInterval(() => {
  if (expires) {
    const left = Math.max(0, Math.ceil((expires - Date.now()) / 1000));
    $("#expiry").textContent = left ? "剩余 " + left + " 秒" : "配对码已过期";
    if (!left) {
      $("#code").textContent = "";
      expires = 0;
    }
  }
}, 1000);
refresh();
setInterval(refresh, 2000);
