param([Parameter(Mandatory=$true)][string]$ExpectedSha256,[Parameter(Mandatory=$true)][string]$VerifierPsBase64,[string]$PackageVersion='3.1.1')
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$base='E:\xxm\file-bridge-single';$dev=$base+'\dev'
$zip=$base+'\release\File-Bridge-'+$PackageVersion+'-windows-x64.zip'
if((Get-FileHash $zip -Algorithm SHA256).Hash.ToLower() -ne $ExpectedSha256.ToLower()){throw 'Existing ZIP is not the complete expected artifact'}
$task=Get-ScheduledTask -TaskName 'FileBridge-Package-Verification' -ErrorAction SilentlyContinue
if($task -and $task.State -eq 'Running'){Stop-ScheduledTask -TaskName $task.TaskName}
# Only a verification directory is selected; formal dev/var is never stopped.
$old=Get-ChildItem ($base+'\release') -Directory -Filter 'package-verification-*'|Sort-Object LastWriteTime -Descending|Select-Object -First 1
if($old){
 $oldRoot=Join-Path $old.FullName ('File-Bridge-'+$PackageVersion+'-windows-x64')
 $state=Join-Path $oldRoot 'var\runtime.json'
 if(Test-Path $state){
  $r=Get-Content $state -Raw|ConvertFrom-Json
  foreach($id in @($r.webPid,$r.tunnelPid,$r.pid)){
   if(!$id){continue}
   $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)
   if($p -and $p.CommandLine -and $p.CommandLine.IndexOf($oldRoot,[StringComparison]::OrdinalIgnoreCase) -ge 0){Stop-Process -Id $id -Force}
  }
 }
}
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
$t=$folder.RegisterTaskDefinition('FileBridge-Package-Verification',$def,6,$null,$null,3);$t.Run($null)|Out-Null
'Complete archive reverified; fresh default-launch and asynchronous compatibility validation started'
