"use strict";
const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  os = require("node:os"),
  cp = require("node:child_process");
const { directory, atomic } = require("./storage.cjs");
function applyStartup(
  profile,
  enabled,
  { platform = process.platform, env = process.env, run = cp.spawnSync } = {},
) {
  const id = crypto
      .createHash("sha256")
      .update(path.resolve(profile))
      .digest("hex")
      .slice(0, 16),
    cli = path.join(__dirname, "cli.cjs");
  let target;
  if (platform === "win32") {
    if (!env.APPDATA) throw Error("Current user APPDATA is unavailable");
    target = path.join(
      env.APPDATA,
      "Microsoft/Windows/Start Menu/Programs/Startup",
      "file-bridge-host-" + id + ".lnk",
    );
    directory(path.dirname(target));
    const q = (s) => "'" + s.replace(/'/g, "''") + "'";
    let script;
    if (enabled) {
      const command =
        "& " +
        q(process.execPath) +
        " " +
        q(cli) +
        " start --profile-dir " +
        q(profile) +
        " | Out-Null";
      const argumentsText =
        "-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand " +
        Buffer.from(command, "utf16le").toString("base64");
      script =
        "$w=New-Object -ComObject WScript.Shell;$s=$w.CreateShortcut(" +
        q(target) +
        ");$s.TargetPath=" +
        q(
          path.join(
            env.SystemRoot || "C:\\Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
        ) +
        ";$s.Arguments=" +
        q(argumentsText) +
        ";$s.WorkingDirectory=" +
        q(profile) +
        ";$s.WindowStyle=7;$s.Save()";
    } else
      script =
        "Remove-Item -LiteralPath " +
        q(target) +
        " -Force -ErrorAction SilentlyContinue";
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
  } else if (platform === "linux") {
    target = path.join(
      env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
      "autostart",
      "file-bridge-host-" + id + ".desktop",
    );
    if (enabled) {
      const q = (s) =>
        '"' + s.replace(/([\\"`$])/g, "\\$1").replace(/%/g, "%%") + '"';
      atomic(
        target,
        "[Desktop Entry]\nType=Application\nName=File Bridge Host\nExec=" +
          q(process.execPath) +
          " " +
          q(cli) +
          " start --profile-dir " +
          q(profile) +
          "\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
      );
    } else fs.rmSync(target, { force: true });
  } else throw Error("Unsupported startup platform");
  if (fs.existsSync(target) !== enabled)
    throw Error("Startup registration verification failed");
  return { enabled, scope: "current-user-login", target };
}
module.exports = { applyStartup };
