$ErrorActionPreference='Stop'
$base='E:\xxm\file-bridge-single'
$zip=$base+'\release\File-Bridge-3.1.0-windows-x64.zip'
$clean=$base+'\release\package-verification-'+[Guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force ($base+'\release')|Out-Null
Invoke-WebRequest 'https://raw.githubusercontent.com/trlstdin/rororororo/refs/heads/projects/file-bridge/release/File-Bridge-3.1.0-windows-x64.zip' -OutFile $zip -UseBasicParsing -TimeoutSec 300
Expand-Archive -LiteralPath $zip -DestinationPath $clean
$root=Join-Path $clean 'File-Bridge-3.1.0-windows-x64'
if(Test-Path ($root+'\var')){throw 'Package includes private state'}
$dev=$base+'\dev'
& 'C:\Windows\System32\tar.exe' -xf ($base+'\backups\package-verification-scripts.tar.gz') -C $dev
if($LASTEXITCODE -ne 0){throw 'Verification script installation failed'}
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$def=$folder.GetTask('FileBridge-Single-Browser-Final').Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$dev+'\scripts\Verify-Package.ps1" -Root "'+$root+'"'
$def.Settings.ExecutionTimeLimit='PT15M'
$t=$folder.RegisterTaskDefinition('FileBridge-Package-Verification',$def,6,$null,$null,3);$t.Run($null)|Out-Null
@{started=$true;archiveBytes=(Get-Item $zip).Length;cleanPackage=$true}|ConvertTo-Json
