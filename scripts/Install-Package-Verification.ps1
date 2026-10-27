param([Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$PackageUrl,[string]$VerifierPsUrl='',[string]$VerifierJsUrl='',[string]$VerifierPsBase64='',[string]$VerifierJsBase64='',[string]$PackageVersion='3.1.1',[switch]$ResumeExisting)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$base='E:\xxm\file-bridge-single'
$zip=$base+'\release\File-Bridge-'+$PackageVersion+'-windows-x64.zip'
$clean=$base+'\release\package-verification-'+[Guid]::NewGuid().ToString('N')
New-Item -ItemType Directory -Force ($base+'\release')|Out-Null
$dev=$base+'\dev'
New-Item -ItemType Directory -Force ($dev+'\scripts')|Out-Null
if($VerifierPsBase64 -and $VerifierJsBase64){
 [IO.File]::WriteAllBytes($dev+'\scripts\Verify-Package.ps1',[Convert]::FromBase64String($VerifierPsBase64))
 [IO.File]::WriteAllBytes($dev+'\scripts\verify-windows-package.cjs',[Convert]::FromBase64String($VerifierJsBase64))
}else{
 Invoke-WebRequest $VerifierPsUrl -OutFile ($dev+'\scripts\Verify-Package.ps1') -UseBasicParsing -TimeoutSec 60
 Invoke-WebRequest $VerifierJsUrl -OutFile ($dev+'\scripts\verify-windows-package.cjs') -UseBasicParsing -TimeoutSec 60
}
$curl=$env:SystemRoot+'\System32\curl.exe'
if(!$ResumeExisting -and (Test-Path $zip)){Remove-Item -LiteralPath $zip}
if(Test-Path $curl){
 $complete=$false
 for($attempt=0;$attempt -lt 3;$attempt++){
  & $curl --fail --location --silent --show-error --connect-timeout 15 --max-time 70 --continue-at - --output $zip $PackageUrl
  if($LASTEXITCODE -eq 0){$complete=$true;break}
 }
 if(!$complete){throw 'Download incomplete; partial bytes retained. Resume with ResumeExisting and the same expected SHA-256.'}
}else{Invoke-WebRequest $PackageUrl -OutFile $zip -UseBasicParsing -TimeoutSec 180}
if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLower() -ne $ExpectedSha256.ToLower()){throw 'Downloaded archive differs from the packaged artifact'}
Expand-Archive -LiteralPath $zip -DestinationPath $clean
$root=Join-Path $clean ('File-Bridge-'+$PackageVersion+'-windows-x64')
if(Test-Path ($root+'\var')){throw 'Package includes private state'}
$dev=$base+'\dev'
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$def=$folder.GetTask('FileBridge-Single-Browser-Final').Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$a.Arguments='-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$dev+'\scripts\Verify-Package.ps1" -Root "'+$root+'"'
$def.Settings.ExecutionTimeLimit='PT15M'
$t=$folder.RegisterTaskDefinition('FileBridge-Package-Verification',$def,6,$null,$null,3);$t.Run($null)|Out-Null
@{started=$true;archiveVerified=$true;archiveBytes=(Get-Item $zip).Length;cleanPackage=$true}|ConvertTo-Json
