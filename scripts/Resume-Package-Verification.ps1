param([Parameter(Mandatory=$true)][string]$Root,[Parameter(Mandatory=$true)][string]$VerifierPsBase64,[Parameter(Mandatory=$true)][string]$VerifierJsBase64)
$ErrorActionPreference='Stop'
$dev='E:\xxm\file-bridge-single\dev'
if(!(Test-Path ($Root+'\FILES.json'))){throw 'Unpacked package inventory missing'}
New-Item -ItemType Directory -Force ($dev+'\scripts')|Out-Null
[IO.File]::WriteAllBytes($dev+'\scripts\Verify-Package.ps1',[Convert]::FromBase64String($VerifierPsBase64))
[IO.File]::WriteAllBytes($dev+'\scripts\verify-windows-package.cjs',[Convert]::FromBase64String($VerifierJsBase64))
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$def=$folder.GetTask('FileBridge-Single-Browser-Final').Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$dev+'\scripts\Verify-Package.ps1" -Root "'+$Root+'"'
$def.Settings.ExecutionTimeLimit='PT15M'
$t=$folder.RegisterTaskDefinition('FileBridge-Package-Verification',$def,6,$null,$null,3);$t.Run($null)|Out-Null
'Already downloaded and integrity-checked archive: clean Windows verification started'
