param([Parameter(Mandatory=$true)][string]$ArchivePath,[switch]$RestartTunnel)
$ErrorActionPreference='Stop'
$root='E:\xxm\file-bridge-single\dev'
$backup='E:\xxm\file-bridge-single\backups'
$stamp=Get-Date -Format 'yyyyMMdd_HHmmss'
$stage=Join-Path $root ('deployment-sources-'+$stamp)
New-Item -ItemType Directory -Force $stage|Out-Null
# Source-only backup; no tokens, received files, node_modules or nested backups.
$paths=@('source/public','source/host','source/server.js','source/package.json','source/README.md','package.json','package-lock.json','README.md','docs','.agents') | ForEach-Object {Join-Path $root $_} | Where-Object {Test-Path -LiteralPath $_}
Compress-Archive -LiteralPath $paths -DestinationPath (Join-Path $backup ('file-bridge_v'+$stamp+'_before-change.zip'))
& 'C:\Windows\System32\tar.exe' -xzf $ArchivePath -C $stage
if($LASTEXITCODE -ne 0){throw 'Source extraction failed'}
$env:FILE_BRIDGE_DEPLOY_STAGE=$stage
$script=@'
const fs=require('fs'),path=require('path');const root='E:/xxm/file-bridge-single/dev',stage=process.env.FILE_BRIDGE_DEPLOY_STAGE;const {atomic}=require(root+'/source/host/storage.cjs');function copy(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const src=path.join(dir,e.name),dest=path.join(root,path.relative(stage,src));if(e.isDirectory()){fs.mkdirSync(dest,{recursive:true});copy(src)}else atomic(dest,fs.readFileSync(src));}}copy(stage);
'@
& 'C:\Program Files\nodejs\node.exe' -e $script
if($LASTEXITCODE -ne 0){throw 'Atomic source installation failed'}
$r=Get-Content ($root+'\var\runtime.json') -Raw|ConvertFrom-Json
if($r.origin -ne 'http://127.0.0.1:18791'){throw 'Unexpected website instance'}
$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.webPid)
if(!$p -or $p.CommandLine -notlike '*file-bridge-single*source*server.js*'){throw 'Website process ownership check failed'}
Stop-Process -Id $r.webPid -Force
$ready=$false
for($i=0;$i -lt 100;$i++){
 Start-Sleep -Milliseconds 300
 try{$h=Invoke-RestMethod 'http://127.0.0.1:18791/health' -TimeoutSec 2;if($h.version -eq ((Get-Content ($root+'\source\package.json') -Raw|ConvertFrom-Json).version)){$ready=$true;break}}catch{}
}
if(!$ready){throw 'Updated website has not recovered'}
if($RestartTunnel){
 $oldUrl=(Get-Content ($root+'\var\current-url.txt') -Raw).Trim()
 $r=Get-Content ($root+'\var\runtime.json') -Raw|ConvertFrom-Json
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$r.tunnelPid)
 if(!$p -or $p.CommandLine -notlike '*cloudflared*'){throw 'Tunnel process ownership check failed'}
 Stop-Process -Id $r.tunnelPid -Force
 $ready=$false
 for($i=0;$i -lt 240;$i++){
  Start-Sleep -Milliseconds 500
  try{$r=Get-Content ($root+'\var\runtime.json') -Raw|ConvertFrom-Json;$u=(Get-Content ($root+'\var\current-url.txt') -Raw).Trim();if($r.tunnelState -eq 'online' -and $u -ne $oldUrl){$ready=$true;break}}catch{}
 }
 if(!$ready){throw 'Rebuilt tunnel has not become ready'}
}
# Reuse the existing isolated browser verification task under the desktop user.
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$t=$folder.GetTask('FileBridge-Single-Browser-Final')
if($t.State -eq 4){throw 'Browser verification task is already running'}
$def=$t.Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$command="Set-Location '$root'; & 'C:\Program Files\nodejs\node.exe' --test tests/server.cjs tests/storage.cjs | Out-File '$root\artifacts\windows-sources-unit.log' -Encoding utf8; if(`$LASTEXITCODE -ne 0){exit 1}; & '$root\tests\Windows-Browser.ps1'"
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$t=$folder.RegisterTaskDefinition('FileBridge-Single-Browser-Final',$def,6,$null,$null,3);$t.Run($null)|Out-Null
'File Bridge website deployed; actual Windows browser verification started'
