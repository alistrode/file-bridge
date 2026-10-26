# File Bridge 3.0

一个主机运行网站并连接 Cloudflare 隧道。手机和电脑打开同一个完整网址，即可互传文字、图片和最大 1 GB 的文件。浏览器无需安装客户端，也没有设备配对、设备列表或双端连接。

## 主机启动

需要 Node.js 22+ 和官方 `cloudflared`；应用没有 npm 运行依赖。也可以把相应平台的二进制放入根目录 `runtime/`，Windows 命名为 `node.exe`、`cloudflared.exe`，Linux 命名为 `node`、`cloudflared`。第三方运行时应保留各自许可证。

- Windows：运行 `Start-File-Bridge.cmd`。
- Linux：运行 `./Start-File-Bridge.sh`。
- 当前公网入口保存在 `var/current-url.txt`；生成网址需要等待隧道连接。
- 查看状态：`node source/host/cli.cjs status`。
- 打开网页：`node source/host/cli.cjs open`。
- 明确停止：`node source/host/cli.cjs stop`，停止后不会被再次拉起。
- 主机登录后自动启动：`node source/host/cli.cjs autostart on`；关闭用 `autostart off`。在实际登录用户的会话中设置。它只启动主机后台，不要求访问网页的人设置任何东西。

首次配置使用临时隧道：

```sh
node source/host/cli.cjs start --profile-dir /absolute/host-state --port 8790 --tunnel quick --cloudflared /absolute/cloudflared
```

后续启动复用相同 profile 的配置。每个 profile 只允许一个监督进程。网站只监听 `127.0.0.1`；公网访问通过 Cloudflare。主机控制接口另设随机回环端口和独立控制凭据，不暴露给网页。

临时隧道重建会更换网址。长期使用建议配置 Cloudflare 命名隧道和固定域名：

```sh
node source/host/cli.cjs start --profile-dir /absolute/host-state --port 8790 --tunnel named --cloudflared /absolute/cloudflared --tunnel-config /private/tunnel.yml --tunnel-name YOUR_TUNNEL --public-url https://files.example.com
```

命名隧道配置中的 ingress 服务必须指向这里设置的主机回环端口。使用已有、有效的 Cloudflare 隧道配置和认证文件；应用不会创建账户、域名或虚构认证。配置和认证文件不要提交仓库。

## 保留的稳定性机制

- 网站和隧道由同一个监督进程分别监控，崩溃后按 1、2、3……秒重试，最长间隔 30 秒。网站连续三次健康检查失败会被重启。隧道自身负责网络重连，监督进程通过其本地 readiness 检查状态。
- 浏览器把待发送文字和文件保存到 IndexedDB。网络中断后自动重试；刷新并重新打开相同网址后读取未完成任务。完成后移除浏览器中的文件副本，仅保留最近发送结果。
- 文件按 1 MiB 分块上传并在主机落盘，每块校验后才确认。主机重启后核对已有分块，只重传缺失或损坏部分。完成时重新核对各块、文件长度并记录完整文件摘要；文件和清单落盘后才返回保存成功。
- 文字任务按请求编号去重，文件按内容清单和名称复用上传结果。确认丢失后重试不会重复生成最近内容。
- 浏览器持续恢复最近内容列表；后台重启保留入口令牌、任务和文件。下载支持 HTTP Range。最近内容保留 24 小时，归档内容永久保存在主机；上传分块与上传记录保留 7 天。
- 日志轮转，每份 2 MiB，保留三份旧日志。不记录访问令牌、文字内容或 Cloudflare 认证文件内容。

## 使用边界

- 主机需要保持开机、联网并有足够磁盘空间。主机断电期间网站不可访问；自动登录启动在相应用户登录后生效。监督进程本身被结束后，需要重新启动主机程序或在下次登录时启动。
- 浏览器存储属于当前网站地址。清除网站数据、使用不保留数据的隐私模式或浏览器回收存储，会影响待发送任务。临时隧道换网址后，旧地址的浏览器任务不会自动跨域搬迁；重新选择相同文件会核对并复用主机上的分块。固定域名可避免这个地址变化问题。
- 公共隧道没有本项目可控制的可用性承诺。当前实现不使用公共 MQTT/WSS 测试中继，也不提供“永不断线”承诺。
- 访问网址包含访问凭据。持有完整网址的人可以查看和发送共享内容，请仅分享给需要使用的人。

## 源码、数据与验证

源码入口为 `source/server.js`、`source/public/` 和 `source/host/`。默认 profile 为根目录 `var/`；源代码、接收内容和运行状态分离。直接调试网站可运行 `node source/server.js`；它默认使用 `source/data/`，并兼容读取原版 `source/received/`、`source/archive/` 中的已有文件。

```sh
npm test
python tests/browser-functional.py /private/current-url.txt
# 在已启动远端测试浏览器的 CDP 接口上验收：
python tests/browser-functional.py /private/current-url.txt http://127.0.0.1:18892
# Windows 用户会话，无需 npm 测试依赖，连接已启动的隔离浏览器：
node tests/browser-windows.cjs 18892
```

浏览器测试需要 Playwright；`npm test` 只使用 Node.js 标准库。故障测试仅操作各自创建的进程和临时目录。验收范围见 `docs/HANDOFF.md`，设计见 `docs/DESIGN.md`。旧版源码 ZIP 仅作历史备份，不属于当前运行程序。`docs/SOURCE-MANIFEST.json` 是原版来源记录，不是 3.0 的当前文件清单。
