# File Bridge

一个无需安装依赖的手机/电脑文件桥。双方打开同一网址即可互传文字、图片和最大 1 GB 的单文件；上传以流方式写入 `received/`，不会占用大量内存。

启动本地版：

```powershell
node server.js
```

启动公网版（电脑和手机不在同一 Wi-Fi）：

```powershell
powershell -ExecutionPolicy Bypass -File .\start-remote.ps1
```

如需完全隐藏窗口，双击 `start-hidden.vbs`。公网地址会静默写入 `current-url.txt`。

终端打印的完整 HTTPS 地址就是手机入口。不要把该地址发给陌生人。
