"""Assemble the self-contained Windows ZIP from fixed official runtime downloads.
Usage: python scripts/build-windows-package.py INPUT_DIR STAGING_DIR
Inputs: node-v26.4.0-win-x64.zip, cloudflared.exe (2026.10.4), cloudflared-LICENSE.
"""
from pathlib import Path
import hashlib,json,shutil,sys,zipfile
root=Path(__file__).resolve().parents[1];inputs=Path(sys.argv[1]);stage=Path(sys.argv[2]);app=stage/'File-Bridge-3.1.0-windows-x64'
if app.exists():raise SystemExit('Use a new staging directory')
(app/'runtime').mkdir(parents=True);(app/'licenses').mkdir()
with zipfile.ZipFile(inputs/'node-v26.4.0-win-x64.zip') as z:
 for name,dest in [('node.exe','runtime/node.exe'),('LICENSE','licenses/Node-LICENSE')]:
  (app/dest).write_bytes(z.read('node-v26.4.0-win-x64/'+name))
shutil.copy2(inputs/'cloudflared.exe',app/'runtime/cloudflared.exe');shutil.copy2(inputs/'cloudflared-LICENSE',app/'licenses/cloudflared-LICENSE')
for file in (root/'source').rglob('*'):
 rel=file.relative_to(root)
 if file.is_file() and (file.suffix in ['.js','.cjs','.html','.css'] or rel.as_posix()=='source/package.json') and not any(p in ['data','received','archive','artifacts'] for p in rel.parts):
  target=app/rel;target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(file,target)
for file in ['package.json','Start-File-Bridge.cmd','File-Bridge-CLI.cmd','Open-File-Bridge.cmd','Stop-File-Bridge.cmd']:
 shutil.copy2(root/file,app/file)
(app/'README.txt').write_text('''File Bridge 3.1 — Windows x64 完整运行包

完整解压此文件夹，再双击 Start-File-Bridge.cmd。无需安装 Node.js、npm 或 cloudflared。
程序启动后台网站和公网隧道，地址准备好后在普通默认浏览器中打开。
其他电脑、手机打开同一完整网址即可上传。每个浏览器可保存来源名称，统一列表可按来源筛选。
Open-File-Bridge.cmd 再次打开网页；Stop-File-Bridge.cmd 停止本实例。
关闭浏览器不会停止后台。需要主机开机联网；临时隧道重建后网址会变化。
首次运行生成 var/，其中有访问凭据和接收数据，请勿公开上传该目录。
登录自启可选：File-Bridge-CLI.cmd autostart on；关闭用 autostart off。
本包不启用登录自启，不要求配对、管理员安装或系统中的 Node.js。
只含 Windows x64 运行时。Windows 11 实机验收；其他 Windows 版本未实机验收。
''',encoding='utf-8')
(app/'THIRD-PARTY.txt').write_text('''Application: File Bridge 3.1, project source on projects/file-bridge.
Third-party components are unmodified upstream distributions, not authored by this project:
Node.js 26.4.0 Windows x64: https://nodejs.org/dist/v26.4.0/node-v26.4.0-win-x64.zip
License (including bundled third-party notices): licenses/Node-LICENSE
cloudflared 2026.10.4 Windows amd64: https://github.com/cloudflare/cloudflared/releases/download/2026.10.4/cloudflared-windows-amd64.exe
Apache-2.0: licenses/cloudflared-LICENSE
Source/license: https://github.com/cloudflare/cloudflared/tree/2026.10.4
No npm production dependencies. Browsers and tests are not included.
''')
manifest={str(p.relative_to(app)).replace('\\','/'):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(app.rglob('*')) if p.is_file()}
(app/'FILES.json').write_text(json.dumps({'version':'3.1.0','platform':'windows-x64','sha256':manifest},indent=2)+'\n')
out=root/'release'/'File-Bridge-3.1.0-windows-x64.zip';out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as z:
 for p in sorted(app.rglob('*')):
  if p.is_file():z.write(p,p.relative_to(stage))
if out.stat().st_size>=100_000_000:raise SystemExit('Package exceeds GitHub regular file limit')
print(json.dumps({'package':str(out),'bytes':out.stat().st_size,'files':len(manifest)+1}))
