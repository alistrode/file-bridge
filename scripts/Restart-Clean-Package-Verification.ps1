param([Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$VerifierPsBase64,[string]$PackageVersion='3.1.1')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$base='E:\xxm\file-bridge-single';$dev=$base+'\dev'
$zip=$base+'\release\File-Bridge-'+$PackageVersion+'-windows-x64.zip'
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $ExpectedSha256.ToLower()){throw 'Existing ZIP is not the complete expected artifact'}
# Remove only processes launched from this project's generated verification directories.
# Do not terminate browsers or the formal dev/var host.
$prefix=$base+'\release\package-verification-'
Get-CimInstance Win32_Process | Where-Object {
 $_.Name -in @('node.exe','cloudflared.exe','powershell.exe','cmd.exe') -and $_.CommandLine -and $_.CommandLine.IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
$clean=$base+'\release\package-verification-'+[Guid]::NewGuid().ToString('N')
Expand-Archive -LiteralPath $zip -DestinationPath $clean
$root=Join-Path $clean ('File-Bridge-'+$PackageVersion+'-windows-x64')
[IO.File]::WriteAllBytes($dev+'\scripts\Verify-Package.ps1',[Convert]::FromBase64String($VerifierPsBase64))
if(!(Test-Path ($dev+'\scripts\verify-windows-package.cjs'))){throw 'Published verification helper is missing'}
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$def=$folder.GetTask('FileBridge-Single-Browser-Final').Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path=$env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe'
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$dev+'\scripts\Verify-Package.ps1" -Root "'+$root+'"'
$def.Settings.ExecutionTimeLimit='PT5M'
$def.Settings.RestartCount=0
$taskName='FileBridge-Package-Verification-'+[Guid]::NewGuid().ToString('N')
[IO.File]::WriteAllText($dev+'\artifacts\package-verification-task.txt',$taskName)
[IO.File]::WriteAllText($dev+'\artifacts\package-verification.json','{"passed":false,"pending":true}')
$t=$folder.RegisterTaskDefinition($taskName,$def,6,$null,$null,3);$t.Run($null)|Out-Null
'Complete archive reverified; fresh default-launch and asynchronous compatibility validation started'
