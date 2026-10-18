"use strict";
const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
} = require("electron");
const path = require("node:path"),
  os = require("node:os");
const { ensure, request } = require("./cli.cjs"),
  { load, logger } = require("./state.cjs");
const args = process.argv.slice(1),
  arg = (n, fallback) =>
    args.includes(n) ? args[args.indexOf(n) + 1] : fallback;
const profile = path.resolve(
    arg("--profile-dir", path.join(os.homedir(), ".file-bridge-v2")),
  ),
  root = path.resolve(__dirname, "../..");
const record = logger(path.join(profile, "logs"));
const log = (event, fields = {}) =>
  record(event, { desktopPid: process.pid, ...fields });
let tray,
  window,
  quitting = false,
  timer,
  pollBusy = false,
  opening,
  loadedToken,
  loadedOrigin,
  pollFailed = false;
app.setName("File Bridge");
app.setPath("userData", path.join(profile, "desktop"));
app.setAppUserModelId?.("filebridge.independent.v2");
app.on("before-quit", () => {
  quitting = true;
  clearInterval(timer);
  log("desktop_quit");
});
if (!app.requestSingleInstanceLock({ profile })) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    if (!argv.includes("--startup")) open().catch(error);
  });
  app.on("window-all-closed", () => {});
  app
    .whenReady()
    .then(async () => {
      log("desktop_started", { startupLaunch: args.includes("--startup") });
      await ensure(profile, arg("--broker"));
      await request(profile, "/api/desktop-config", {
        executable: process.execPath,
        appRoot: root,
      });
      const image = nativeImage.createFromPath(
        path.join(__dirname, "assets/bridge.png"),
      );
      if (image.isEmpty()) throw Error("File Bridge tray image is missing");
      tray = new Tray(image);
      tray.setToolTip("File Bridge");
      tray.on("click", () => {
        log("tray_clicked");
        open().catch(error);
      });
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 File Bridge 网页", click: () => open().catch(error) },
          {
            label: "打开本实例日志目录",
            click: () => shell.openPath(path.join(profile, "logs")),
          },
          { type: "separator" },
          { label: "退出托盘，保持连接", click: () => app.quit() },
          {
            label: "停止本实例并退出",
            click: async () => {
              quitting = true;
              clearInterval(timer);
              try {
                await request(profile, "/api/shutdown", {});
              } catch (e) {
                log("desktop_stop_error", { reason: e.code || e.name });
              }
              app.quit();
            },
          },
        ]),
      );
      await poll();
      timer = setInterval(poll, 1000);
      timer.unref();
      const state = await request(profile, "/api/status");
      if (!args.includes("--startup") || state.settings.openOnStartup)
        await open();
      log("desktop_ready");
    })
    .catch(error);
}
function makeWindow() {
  window = new BrowserWindow({
    width: 1120,
    height: 850,
    minWidth: 760,
    minHeight: 600,
    title: "File Bridge",
    icon: path.join(__dirname, "assets/bridge.png"),
    show: false,
    backgroundColor: "#0b1020",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  window.setMenu(null);
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
      log("dashboard_hidden");
    }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== loadedOrigin) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, permission, callback) =>
      callback(
        permission === "clipboard-sanitized-write" ||
          permission === "clipboard-write",
      ),
  );
}
async function open() {
  if (quitting) return;
  if (opening) return opening;
  opening = (async () => {
    const runtime = load(path.join(profile, "runtime.json"), null);
    if (!runtime) throw Error("File Bridge backend unavailable");
    if (!window || window.isDestroyed()) makeWindow();
    if (loadedToken !== runtime.token) {
      loadedOrigin = runtime.origin;
      await window.loadURL(runtime.origin + "/?token=" + runtime.token);
      loadedToken = runtime.token;
    }
    window.show();
    window.focus();
    log("browser_open_requested");
  })();
  try {
    await opening;
  } finally {
    opening = null;
  }
}
async function poll() {
  if (quitting || pollBusy) return;
  pollBusy = true;
  try {
    const result = await request(profile, "/api/desktop/poll", {});
    const runtime = load(path.join(profile, "runtime.json"), null);
    if (
      result.requestIds.length ||
      (window?.isVisible() && runtime && loadedToken !== runtime.token)
    )
      await open();
    if (pollFailed) log("desktop_backend_recovered");
    pollFailed = false;
  } catch (e) {
    if (!pollFailed)
      log("desktop_backend_unavailable", { reason: e.code || e.name });
    pollFailed = true;
  } finally {
    pollBusy = false;
  }
}
function error(e) {
  log("desktop_error", { reason: e.code || e.name });
  if (!quitting) dialog.showErrorBox("File Bridge", e.message);
}
