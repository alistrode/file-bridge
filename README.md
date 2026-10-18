# File Bridge 1.0.0

长期分支：`projects/file-bridge`。

手机和电脑打开同一网址，互传文字、图片和文件，单个文件上限 1 GiB。最近收到的内容保留 24 小时，可以永久归档到运行电脑。

## 源码与启动

完整应用和必要网页资源位于 `source/`，Windows 公网启动脚本也在同一目录。原始项目说明见 `source/README.md`。这是从 B 主机 Codex Mini 目录取得的独立 File Bridge 子项目，不是整个 Codex Mini 项目的备份。

需要已有 Node.js 18 或更新版本，不需要 npm 安装依赖：

```sh
cd source
node server.js
```

启动后终端会显示含随机访问令牌的本地网址。Windows 公网启动还需要 PATH 中已有 `cloudflared`，然后在 `source/` 内运行 `start-remote.ps1`，或双击 `start-hidden.vbs`。公网入口写入本机 `current-url.txt`，不要提交或公开分享。Cloudflare Quick Tunnel 重建后域名会变化。

- Node.js 官方来源：https://nodejs.org/ （源码要求 >=18；本次 Linux 验证版本见 `docs/VALIDATION.json`）。
- cloudflared 官方来源：https://github.com/cloudflare/cloudflared/releases 。原项目没有固定其版本，本次没有下载、打包或验证它。
- `capture_win10.py` 是可选 Windows 截图测试，需要 Python 和 Pillow，不是网站运行依赖；运行前通过 `FILE_BRIDGE_TEST_URL` 指定自己的私密入口。
- 默认端口 8790，默认绑定 0.0.0.0；只需本地访问时可以用 `HOST=127.0.0.1`。首次运行会新建数据目录和访问令牌。

## 来源与验证

来源：B 主机 `G:\Downloads\Codex-Mini-main\Codex-Mini-main\file-bridge`。该目录及父目录没有 `.git`，因此无法恢复其历史提交或确认原始 File Bridge 作者。父项目说明指向 https://github.com/CoimgRain/Codex-Mini ，这不是 File Bridge 上游来源或许可证已经确认的证据。

没有上传原机器访问令牌、当前公网地址、收到的文件、永久归档内容、截图和运行日志。仅将截图测试中写死的历史访问令牌改为从环境变量读取，网站实现与远端逐字节一致。详见 `docs/SOURCE-MANIFEST.json`。

本次只交付源码及源码备份，不包含 Node.js、cloudflared 或独立运行包。Linux 已验证文字与文件往返、归档和重启持久化；Windows 原生启动、公网隧道及实体手机未在本次重验，详见 `docs/VALIDATION.json`。
