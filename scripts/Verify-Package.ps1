param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$env:PATH=$env:SystemRoot+'\System32;'+$env:SystemRoot+';'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0'
$dev='E:\xxm\file-bridge-single\dev'
try{
 if(Get-Command node -ErrorAction SilentlyContinue){throw 'System node must not be present on verification PATH'}
 Set-Location $Root
 $normal=Start-Process -FilePath $env:ComSpec -ArgumentList @('/d','/c',('"'+$Root+'\Start-File-Bridge.cmd"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput ($dev+'\artifacts\package-start-private.log') -RedirectStandardError ($dev+'\artifacts\package-start-error.log')
 & ($Root+'\runtime\node.exe') ($dev+'\scripts\verify-windows-package.cjs') $Root ($dev+'\artifacts\package-verification.json') 2>&1 | Out-File ($dev+'\artifacts\package-verification.log') -Encoding utf8
 if($LASTEXITCODE -ne 0){throw 'Package verification failed'}
 if(!$normal.WaitForExit(15000)){throw 'One-click launcher has not returned after website startup'}
 $stopped=$false
 for($i=0;$i -lt 30;$i++){
  try{$state=Get-Content ($Root+'\var\runtime.json') -Raw|ConvertFrom-Json;if(!$state.pid){$stopped=$true;break}}catch{}
  Start-Sleep -Milliseconds 500
 }
 if(!$stopped){throw 'Previous phase has not fully stopped'}
 $compat=Start-Process -FilePath ($env:SystemRoot+'\System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"'+$Root+'\source\start-remote.ps1"')) -WindowStyle Hidden -PassThru -RedirectStandardOutput ($dev+'\artifacts\package-compat-start-private.log') -RedirectStandardError ($dev+'\artifacts\package-compat-start-error.log')
 & ($Root+'\runtime\node.exe') ($dev+'\scripts\verify-windows-package.cjs') $Root ($dev+'\artifacts\package-verification.json') --compat 2>&1 | Out-File ($dev+'\artifacts\package-compat-verification.log') -Encoding utf8
 if($LASTEXITCODE -ne 0){throw 'Compatibility package verification failed'}
 if(!$compat.WaitForExit(30000)){throw 'Compatibility wrapper did not exit after explicit stop'}
 if($null -ne $compat.ExitCode -and $compat.ExitCode -ne 0){throw 'Compatibility wrapper exited unsuccessfully'}
}catch{ @{passed=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content ($dev+'\artifacts\package-verification.json') -Encoding UTF8;exit 1}
