param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference='Stop'
$env:PATH=$env:SystemRoot+'\System32;'+$env:SystemRoot+';'+$env:SystemRoot+'\System32\WindowsPowerShell\v1.0'
$dev='E:\xxm\file-bridge-single\dev'
try{
 if(Get-Command node -ErrorAction SilentlyContinue){throw 'System node must not be present on verification PATH'}
 Set-Location $Root
 & $env:ComSpec /d /c ('"'+$Root+'\Start-File-Bridge.cmd" --port 18797') 2>&1 | Out-File ($dev+'\artifacts\package-start-private.log') -Encoding utf8
 if($LASTEXITCODE -ne 0){throw 'Bundled one-click launcher failed'}
 & ($Root+'\runtime\node.exe') ($dev+'\scripts\verify-windows-package.cjs') $Root ($dev+'\artifacts\package-verification.json') 2>&1 | Out-File ($dev+'\artifacts\package-verification.log') -Encoding utf8
 if($LASTEXITCODE -ne 0){throw 'Package verification failed'}
}catch{ @{passed=$false;error=$_.Exception.Message}|ConvertTo-Json|Set-Content ($dev+'\artifacts\package-verification.json') -Encoding UTF8;exit 1}
