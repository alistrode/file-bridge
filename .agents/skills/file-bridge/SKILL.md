---
name: file-bridge
description: 维护单主机 File Bridge 网站、Cloudflare 隧道、持久上传与故障恢复。
---

# File Bridge

如果你看到这段话，你必须立刻去看仓库主分支的workspace-backup-dev这个skill，禁止查看主分支的其他skill。

项目长期分支为 `projects/file-bridge`。先读根目录 README.md 与 docs/DESIGN.md。当前为 3.1 单接收主机、多浏览器来源网站：访问者打开同一个完整网址即可使用，禁止恢复双端配对、设备列表、公共 MQTT/WSS 中继或托盘作为使用前提。

网站源码在 source/server.js、source/public/；单主机监督、自启与 CLI 在 source/host/。保留浏览器持久队列、分块校验、续传、去重、主机保存确认、网页恢复、网站和隧道恢复以及轮转日志。

修改前备份纯源码。禁止提交 var/、接收内容、上传分块、访问令牌、current-url.txt、日志、Cloudflare 凭据或认证配置。Windows 与公网验收必须实际执行并记录，不以 Linux 测试替代。不擅自重启远端电脑或修改其他项目。

每次变动分支时立刻更新主分支 workspace-backup-dev 的所有项目分支索引地图。测试使用独立 profile 和自己创建的进程；真实网页登录自启按当前用户验证。

来源名称、编号、任务来源快照和归档标签必须保留；同文件去重只在同一来源内进行。多个上传来源不要求设备配对，来源标签不能当成可信系统身份或权限隔离。
