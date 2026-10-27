# Historical executed 3.0 migration. Fixed E:\xxm paths; not an end-user installer.
$ErrorActionPreference='Stop'
$b='E:\xxm\file-bridge-single';$dev=$b+'\dev'
& 'C:\Windows\System32\tar.exe' -xzf ($b+'\backups\file-bridge_v3.0_source.tar.gz') -C $dev
if($LASTEXITCODE -ne 0){throw 'Source extraction failed'}
New-Item -ItemType Directory -Force ($dev+'\tools'),($dev+'\artifacts'),($dev+'\var\site\received'),($dev+'\var\site\archive')|Out-Null
Copy-Item 'E:\xxm\file-bridge-validation\dev\tools\cloudflared.exe' ($dev+'\tools\cloudflared.exe') -Force
$old='E:\xxm\file-bridge-validation\dev\source'
foreach($name in @('token.txt','items.json')){if((Test-Path ($old+'\data\'+$name)) -and !(Test-Path ($dev+'\var\site\'+$name))){Copy-Item ($old+'\data\'+$name) ($dev+'\var\site\'+$name)}}
if(Test-Path ($old+'\received')){Get-ChildItem ($old+'\received') -File | ForEach-Object{if(!(Test-Path ($dev+'\var\site\received\'+$_.Name))){Copy-Item $_.FullName ($dev+'\var\site\received')}}}
if(Test-Path ($old+'\archive\items.json')){Copy-Item ($old+'\archive\items.json') ($dev+'\var\site\archive\items.json')}
if(Test-Path ($old+'\archive\files')){Get-ChildItem ($old+'\archive\files') -File | Copy-Item -Destination ($dev+'\var\site\archive')}
Set-Location $dev
& 'C:\Program Files\nodejs\node.exe' --test tests/server.cjs tests/host.cjs
if($LASTEXITCODE -ne 0){throw 'Windows tests failed'}
& 'C:\Program Files\nodejs\node.exe' source/host/cli.cjs start --profile-dir ($dev+'\var') --port 18791 --tunnel quick --cloudflared ($dev+'\tools\cloudflared.exe') | Out-File ($dev+'\artifacts\start-private.json') -Encoding utf8
if($LASTEXITCODE -ne 0){throw 'Host startup failed'}
'File Bridge 3.0 host started; public entry remains in private profile'
