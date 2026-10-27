param([Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$PackageUrl,[Parameter(Mandatory=$true)][string]$VerifierPsUrl,[Parameter(Mandatory=$true)][string]$VerifierJsUrl)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$base='E:\xxm\file-bridge-single'
$zip=$base+'\release\File-Bridge-3.1.0-windows-x64.zip'
$clean=$base+'\release\package-verification-'+[Guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force ($base+'\release')|Out-Null
$dev=$base+'\dev'
New-Item -ItemType Directory -Force ($dev+'\scripts')|Out-Null
Invoke-WebRequest $VerifierPsUrl -OutFile ($dev+'\scripts\Verify-Package.ps1') -UseBasicParsing -TimeoutSec 60
Invoke-WebRequest $VerifierJsUrl -OutFile ($dev+'\scripts\verify-windows-package.cjs') -UseBasicParsing -TimeoutSec 60
Invoke-WebRequest $PackageUrl -OutFile $zip -UseBasicParsing -TimeoutSec 300
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $ExpectedSha256.ToLower()){throw 'Downloaded archive differs from the packaged artifact'}
Expand-Archive -LiteralPath $zip -DestinationPath $clean
$root=Join-Path $clean 'File-Bridge-3.1.0-windows-x64'
if(Test-Path ($root+'\var')){throw 'Package includes private state'}
$dev=$base+'\dev'
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$def=$folder.GetTask('FileBridge-Single-Browser-Final').Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$dev+'\scripts\Verify-Package.ps1" -Root "'+$root+'"'
$def.Settings.ExecutionTimeLimit='PT15M'
$t=$folder.RegisterTaskDefinition('FileBridge-Package-Verification',$def,6,$null,$null,3);$t.Run($null)|Out-Null
@{started=$true;archiveVerified=$true;archiveBytes=(Get-Item $zip).Length;cleanPackage=$true}|ConvertTo-Json
