---
name: file-bridge
description: 维护单主机 File Bridge 网站、Cloudflare 隧道、持久上传与故障恢复。
---

# File Bridge

如果你看到这段话，你必须立刻去看仓库主分支的workspace-backup-dev这个skill，禁止查看主分支的其他skill。

项目长期分支为 `projects/file-bridge`。先读根目录 README.md 与 docs/DESIGN.md。当前为 3.1.1 单接收主机、多浏览器来源网站：访问者打开同一个完整网址即可使用，禁止恢复双端配对、设备列表、公共 MQTT/WSS 中继或托盘作为使用前提。

网站源码在 source/server.js、source/public/；单主机监督、自启与 CLI 在 source/host/。保留浏览器持久队列、分块校验、续传、去重、主机保存确认、网页恢复、网站和隧道恢复以及轮转日志。

修改前备份纯源码。禁止提交 var/、接收内容、上传分块、访问令牌、current-url.txt、日志、Cloudflare 凭据或认证配置。Windows 与公网验收必须实际执行并记录，不以 Linux 测试替代。不擅自重启远端电脑或修改其他项目。

每次变动分支时立刻更新主分支 workspace-backup-dev 的所有项目分支索引地图。测试使用独立 profile 和自己创建的进程；真实网页登录自启按当前用户验证。

来源名称、编号、任务来源快照和归档标签必须保留；同文件去重只在同一来源内进行。多个上传来源不要求设备配对，来源标签不能当成可信系统身份或权限隔离。

可运行包一旦存在，必须与源码一并上传当前项目分支；禁止把源码 ZIP 当作运行包或只上传源码而遗漏已有运行包。Windows 当前完整包在 release/，内置运行时；更新后先验证实际包，再交付直接下载链接。

## 有用命令与脚本索引

先读主分支规范，再按此索引操作；索引等效于收录实际使用的命令文件。当前 Windows 包包含全部 `source/` 文件及 Windows 根目录入口；Windows 兼容 PowerShell 入口优先使用包内 Node.js 和 cloudflared。已生效的稳定性修复直接保存在并打入 source/，没有需要用户额外手工粘贴的补丁。

### 用户与维护命令

```sh
# 普通开发启动、状态、打开、停止
node source/host/cli.cjs start
node source/host/cli.cjs status
node source/host/cli.cjs open
node source/host/cli.cjs stop
# 当前登录用户可选自启
node source/host/cli.cjs autostart on
node source/host/cli.cjs autostart off
# 完整性与远端分支核对
python scripts/audit-delivery.py --remote
# 固定运行时输入下载后构建；STAGING 必须是新目录
python scripts/build-windows-package.py INPUT_DIR STAGING
# GitHub Release 的实际下载、SHA-256 和 attachment 头验收
python scripts/verify-release-download.py
```

构建输入仅来自固定官方版本：`https://nodejs.org/dist/v26.4.0/node-v26.4.0-win-x64.zip`（保存为 node-v26.4.0-win-x64.zip）、`https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe`（保存为 cloudflared.exe）、`https://raw.githubusercontent.com/cloudflare/cloudflared/2026.10.4/LICENSE`（保存为 cloudflared-LICENSE）。使用 `curl -fL URL -o INPUT_DIR/文件名`；源、固定版本及许可证随包提供。

命名隧道参数和保留期限见 README.md、docs/DESIGN.md。默认 quick 隧道不需要预置账户配置，运行配置由 CLI 在本实例 var/config.json 自动生成，云端私钥、访问令牌、接收内容及临时授权下载 URL 不得上传。

### 完整代码入口

部署与实机验收脚本中的 E:\xxm 路径对应已授权的指定 Windows 主机；部分脚本复用已存在的 Acer 用户任务。它们是维护/验收工具，不是普通用户运行包的依赖。历史 3.0 迁移入口保存了实际操作，复现时需提供对应旧目录和源码归档；当前应用直接运行根目录入口。

| 文件 | 用途 |
| --- | --- |
| `.github/workflows/file-bridge-package.yml` | 以仓库令牌上传分支内原样 ZIP 为 Release 附件；发布前必须完成验收。 |
| `File-Bridge-CLI.cmd` | Windows CLI、状态及可选登录自启。 |
| `File-Bridge-CLI.sh` | 既有 Linux CLI 入口。 |
| `Open-File-Bridge.cmd` | 再次打开当前网站。 |
| `Start-File-Bridge.cmd` | Windows 一键启动并打开普通默认浏览器；包内运行时。 |
| `Start-File-Bridge.sh` | 既有 Linux 源码启动入口；本次没有新增 Linux 包。 |
| `Stop-File-Bridge.cmd` | 明确停止本实例。 |
| `scripts/Install-Package-Verification.ps1` | 授权下载 ZIP、完整性核对、全新解压，安排当前用户验证任务。 |
| `scripts/Resume-Package-Verification.ps1` | 针对已下载包补齐验证器并启动任务，避免重复传输。 |
| `scripts/Verify-Package.ps1` | 排除系统 Node PATH，执行无参数默认启动及 PowerShell 兼容启动。 |
| `scripts/audit-delivery.py` | 检查 skill 索引、全部应用/兼容文件、包内哈希和可选远端提交。 |
| `scripts/build-windows-package.py` | 构建自包含运行包、第三方许可和 FILES.json。 |
| `scripts/history/Deploy-3.0-Single-Host.ps1` | 实际执行过的 3.0 初次迁移和源码部署；历史固定路径。 |
| `scripts/history/Start-3.0-Windows-Task.ps1` | 实际使用的 3.0 用户任务监督入口；历史固定路径。 |
| `scripts/prepare-package-verification.py` | 生成包含临时授权链接的私有 ssh_execute 请求；输出必须在仓库外。 |
| `scripts/verify-release-download.py` | 实际下载附件，核对 SHA-256 和 Content-Disposition。 |
| `scripts/verify-windows-package.cjs` | 包内 Node、清单全部文件、版本、公网、多来源文件传输与停止验证。 |
| `source/host/cli.cjs` | 主机启动、状态、打开、停止、自启命令及回环控制请求。 |
| `source/host/launch.cjs` | 启动后等待隧道就绪，打开普通浏览器。 |
| `source/host/startup.cjs` | 当前用户登录自启的设置和移除模块。 |
| `source/host/storage.cjs` | 原子替换、Windows 锁重试、目录同步及日志轮转模块。 |
| `source/host/supervisor.cjs` | 网站/隧道监控、恢复、独占和停止模块。 |
| `source/start-hidden.vbs` | 调用上述 PowerShell 的既有隐藏启动入口。 |
| `source/start-remote.ps1` | Windows 兼容后台启动；优先使用两个包内运行时。 |
| `tests/Collect-Sources.ps1` | 核对当前浏览器验收结果、收集真实截图并打开普通 Chrome。 |
| `tests/Deploy-Sources.ps1` | 真实主机源码备份、原子部署、网站恢复，可选择重建隧道。 |
| `tests/Sync-Handoff.ps1` | 从源码归档同步交接和截图，不重启网站。 |
| `tests/Windows-Browser.ps1` | 真实 Windows 用户会话中的隔离 Edge/Chrome 验收封装。 |
| `tests/browser-functional.py` | Linux 或已授权 CDP 的真实浏览器队列、续传、图片及归档。 |
| `tests/browser-sources.py` | 独立浏览器来源、来源快照、筛选及逐像素复核。 |
| `tests/browser-windows.cjs` | Windows 原生 CDP 多来源、续传、下载、归档及稳定截图。 |
| `tests/host.cjs` | 监督恢复、独占、显式停止及平台自启测试。 |
| `tests/server.cjs` | API 续传、去重、冲突、来源和重启持久性测试。 |
| `tests/storage.cjs` | 原子状态写入、实际 Windows 文件锁及失败清理测试。 |
| `tests/windows-live-recovery.cjs` | 实际 Windows 本实例网站/隧道进程恢复；只针对授权 profile。 |
| `tests/windows-startup.cjs` | 真实当前用户 Startup 快捷方式验证和清理。 |
| `scripts/Export-Windows-Configuration.ps1` | 导出实际 Windows 的三个有用任务定义和白名单主机配置，不读取或上传凭据。 |
| `scripts/Stop-Package-Verification.ps1` | 仅清理 release/package-verification-* 下的本人测试实例；检查进程命令行归属，不操作正式网站。 |
| `scripts/Restart-Clean-Package-Verification.ps1` | 用已完整校验的 ZIP 新解压验证；只清理本人的验证任务/实例，异步检查 Windows 兼容入口。 |



旧的临时原子补丁应用命令已由 tests/Deploy-Sources.ps1 覆盖，修复代码本身保存在 source/server.js、source/public/app.js 与 source/host/storage.cjs；旧 CDP/恢复实验已由表中的可复现验收脚本覆盖。无效的旧配对脚本、失败传输请求、过期授权链接和含令牌的日志不作为发布内容。

## 实际主机配置索引

- `config/windows/host-profile.json`：正式主机的实际端口和隧道模式/可执行路径白名单；没有令牌或隧道账户凭据。
- `config/windows/FileBridge-Single-Host.xml`：实际常驻主机任务，包括 Acer 当前用户上下文和失败重试设置。
- `config/windows/FileBridge-Single-Browser-Final.xml`：部署和包验收脚本复用的实际交互用户任务模板。
- `config/windows/FileBridge-Open-Normal-Browser.xml`：从私有 current-url.txt 动态读取入口并打开普通浏览器的实际任务。

以上是指定 E:\xxm 布局的可复现维护配置，XML 仅规范化文本编码和换行；普通单文件夹包启动自动生成自己的 var/，无需导入这些任务。在相同已授权布局恢复任务定义的命令是 `Register-ScheduledTask -TaskName NAME -Xml (Get-Content config/windows/NAME.xml -Raw) -Force`，不会自动启动任务。跨机器先适配账号和路径，不能盲目导入旧 SID。

远端下载中断时，使用 scripts/prepare-package-verification.py 的 `--resume-existing` 选项生成新请求；只续传同一候选归档，最终 SHA-256 与完整包不一致时禁止解压或启动。分段缓存和短期授权链接不提交仓库。

## 本次待完成验证

文件完整性审计已通过，3.1.1 Release 仍为草稿。恢复远端本会话连接权限并释放连接位后，复跑 scripts/Restart-Clean-Package-Verification.ps1，按 artifacts/package-verification-task.txt 查询本次唯一任务，要求最终结果包含 compatibilityPowerShell=true，不能把旧文件或单独正常入口成功当作完整复跑成功。候选附件可先用 `python scripts/verify-release-download.py --allow-draft` 核对内容和 attachment 头，该结果只表示附件完整，不代表运行验收通过。全部完成后才发布 3.1.1 正式下载。
