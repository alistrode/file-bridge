# File Bridge 2.0

分支：`projects/file-bridge`。手机/电脑文件网页项目的独立双端升级版：一次配对记住设备，互发文字、图片和文件，并可以请求另一台打开网页。两端功能完全相同。

## 一键启动与开发

- Windows：双击 `Start-File-Bridge.cmd`。
- Linux：运行 `./Start-File-Bridge.sh`。
- 源码模式需要 Node.js 22+，首次运行自动安装锁定依赖和校验后的 Electron；之后直接启动，不编译 Chromium 或应用源码。
- 完整运行包内置官方 Electron 和生产依赖，解压保留整个文件夹后使用同名脚本启动。
- 无桌面云端：`node scripts/start-dev.cjs --headless --profile-dir /private/file-bridge`。
- 独立调试：一键脚本后加 `--profile-dir <独立目录>`。不会占用旧版端口或信道。

启动后托盘点击打开应用自带的网页窗口。在任意一端生成配对码，在另一端输入即可记住设备。网页关闭后连接继续；托盘菜单可打开日志、单独退出托盘或停止本实例。

网页可分别设置“登录电脑后启动”和“自动启动时打开网页”。Windows 在登录当前账户后显示托盘，不擅自安装系统服务。远程打开网页请求默认需要接收方确认，只有明确开启某台设备的自动打开权限后才自动执行。

## 稳定性与数据

- 连续失败按 1、2、3……秒增加等待，稳定后复位，持续自动连接同一已配对身份。
- 两个独立公共 WSS 中继同时工作；任务落盘，接收确认、文件分块检查点和 SHA-256 校验避免把“发送给中继”误当成完成。
- 默认状态：`~/.file-bridge-v2`。收到的文件、配对身份、日志和发送队列都在对应 profile；不要删除该目录来处理普通掉线。
- 文字上限 64 KiB，单文件上限 1 GiB。两端需要运行此版本。原有 1.0 公网网页及 Cloudflare 脚本仍位于 `source/` 根目录，新程序位于 `source/bridge/`。

设计、隔离边界和可用性范围见 [设计说明](docs/DESIGN.md)，验证结果见 `docs/` 下的验证记录。不能把公共免费中继的可用性变成“永不断线”承诺。

## 开发、测试与快速打包

```sh
npm ci --ignore-scripts
npm test
npm run test:public
node scripts/download-runtime.cjs --platform linux --out /absolute/verified-runtime
node scripts/package.cjs --platform linux --runtime /absolute/verified-runtime --out /absolute/new-package-folder
```

Windows 使用 `--platform win32` 和对应 Windows 运行时。打包直接复制校验后的官方运行时和锁定生产依赖，不重新编译，单次处理一个平台。下载器支持四段并行、低于 800 KiB/s 时切换可信来源，必须匹配官方 SHA-256 才会解压。开发模式已存在运行时可通过本进程 `FILE_BRIDGE_ELECTRON` 指定，避免重复下载。

源码不含访问令牌、配对码、私钥、收到的文件或运行日志；测试截图不应出现私密入口。原始 1.0 来源与校验记录仍保留于 `docs/SOURCE-MANIFEST.json`，2.0 为本分支新增实现。
