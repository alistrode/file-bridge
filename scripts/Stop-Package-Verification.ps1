param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$base='E:\xxm\file-bridge-single\release\package-verification-'
$resolved=[IO.Path]::GetFullPath($Root)
if(!$resolved.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Only isolated package-verification directories may be stopped'}
$state=Join-Path $resolved 'var\runtime.json'
if(!(Test-Path $state)){return}
$r=Get-Content $state -Raw|ConvertFrom-Json
try {& ($resolved+'\runtime\node.exe') ($resolved+'\source\host\cli.cjs') stop --profile-dir ($resolved+'\var') 2>&1|Out-Null}catch{}
Start-Sleep -Seconds 2
foreach($id in @($r.webPid,$r.tunnelPid,$r.pid)){
 if(!$id){continue}
 $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$id)
 if($p -and $p.CommandLine -and $p.CommandLine.IndexOf($resolved,[StringComparison]::OrdinalIgnoreCase) -ge 0){Stop-Process -Id $id -Force}
}
'Only this isolated package verification instance was stopped'
