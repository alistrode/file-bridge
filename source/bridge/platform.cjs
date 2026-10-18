"use strict";
const os = require("node:os"),
  path = require("node:path"),
  fs = require("node:fs"),
  cp = require("node:child_process"),
  crypto = require("node:crypto");
const { save, directory } = require("./state.cjs");
function profileId(profile) {
  return crypto
    .createHash("sha256")
    .update(path.resolve(profile))
    .digest("hex")
    .slice(0, 16);
}
function launchBrowser(
  url,
  { platform = process.platform, spawn = cp.spawn } = {},
) {
  const u = new URL(url);
  if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || !u.port)
    throw Error("Only this instance local dashboard can be opened");
  if (platform === "win32") {
    const script =
      "Start-Process -FilePath " + "'" + u.href.replace(/'/g, "''") + "'";
    return spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, stdio: "ignore" },
    );
  }
  if (platform === "linux")
    return spawn("xdg-open", [u.href], { stdio: "ignore" });
  throw Error("Unsupported desktop platform");
}
function linuxEntry({ executable, appRoot, profile }) {
  const quote = (s) =>
    '"' +
    String(s)
      .replace(/([\\"`$])/g, "\\$1")
      .replace(/%/g, "%%") +
    '"';
  return (
    "[Desktop Entry]\nType=Application\nName=File Bridge\nExec=" +
    quote(executable) +
    " --disable-setuid-sandbox " +
    quote(appRoot) +
    " --profile-dir " +
    quote(profile) +
    " --startup\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
  );
}
function windowsStartupScript({
  executable,
  appRoot,
  profile,
  target,
  enabled,
}) {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  if (!enabled)
    return (
      "Remove-Item -LiteralPath " +
      q(target) +
      " -Force -ErrorAction SilentlyContinue"
    );
  const args = '"' + appRoot + '" --profile-dir "' + profile + '" --startup';
  return (
    "$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(" +
    q(target) +
    ");$s.TargetPath=" +
    q(executable) +
    ";$s.Arguments=" +
    q(args) +
    ";$s.WorkingDirectory=" +
    q(appRoot) +
    ";$s.Save()"
  );
}
function startupPath(profile, platform = process.platform, env = process.env) {
  const name = "file-bridge-v2-" + profileId(profile);
  if (platform === "win32") {
    if (!env.APPDATA) throw Error("APPDATA unavailable");
    return path.join(
      env.APPDATA,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      name + ".lnk",
    );
  }
  if (platform === "linux")
    return path.join(
      env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "autostart",
      name + ".desktop",
    );
  throw Error("Unsupported platform");
}
function applyStartup(
  options,
  enabled,
  { platform = process.platform, env = process.env, run = cp.spawnSync } = {},
) {
  if (typeof enabled !== "boolean") throw Error("Invalid startup setting");
  const target = startupPath(options.profile, platform, env);
  if (enabled) directory(path.dirname(target));
  if (platform === "linux") {
    if (enabled) {
      const tmp = target + ".tmp";
      fs.writeFileSync(tmp, linuxEntry(options), { mode: 0o600 });
      fs.renameSync(tmp, target);
    } else fs.rmSync(target, { force: true });
  } else {
    const script = windowsStartupScript({ ...options, target, enabled });
    const r = run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    if (r.error || r.status !== 0) throw Error("Startup registration failed");
  }
  if (fs.existsSync(target) !== enabled)
    throw Error("Startup registration could not be verified");
  return {
    enabled,
    registered: enabled,
    scope: "current-user-login",
    name: path.basename(target),
  };
}
module.exports = {
  profileId,
  launchBrowser,
  linuxEntry,
  windowsStartupScript,
  startupPath,
  applyStartup,
};
