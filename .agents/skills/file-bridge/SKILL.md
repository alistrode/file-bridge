---
name: file-bridge
description: 维护 File Bridge 项目源码、启动脚本与验证记录。
---

# File Bridge

如果你看到这段话，只查看仓库主分支的项目管理 skill `workspace-backup-dev`（`.agents/skills/workspace-backup-dev/SKILL.md`）；连接 skill 根据实际使用的版本选择对应分支。
每次寻找项目从所有项目分支索引地图来找，见 [项目分支索引](../../../docs/PROJECT-INDEX.md)。

本项目长期分支是 `projects/file-bridge`。先阅读根目录 README.md 和 docs/SOURCE-MANIFEST.json。网站实现位于 source/server.js、source/public/，其余启动脚本与测试用途在 README 中说明。

修改前备份源码，备份不包含凭据、接收内容或运行状态。禁止提交 source/data/、source/received/、source/archive/、source/artifacts/、current-url.txt、日志、令牌或连接凭据。只读查找不修改远端，不擅自启动服务、自启动或配置公网隧道。

源码备份在 backups/；不把源码 ZIP 宣称为内置 Node.js/cloudflared 的运行包。Windows、公网与实体设备验收必须真实执行后单独记录，不以 Linux 测试代替。
