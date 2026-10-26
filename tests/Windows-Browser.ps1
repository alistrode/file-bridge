param([string]$BrowserPath='')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSScriptRoot
$artifacts=Join-Path $root 'artifacts'
New-Item -ItemType Directory -Force $artifacts|Out-Null
$node=Join-Path $root 'runtime\node.exe'
if(!(Test-Path $node)){$node=(Get-Command node -ErrorAction Stop).Source}
if([string]::IsNullOrWhiteSpace($BrowserPath)){
 $BrowserPath='C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
 if(!(Test-Path $BrowserPath)){$BrowserPath='C:\Program Files\Google\Chrome\Application\chrome.exe'}
}
if(!(Test-Path $BrowserPath)){throw 'A Chromium browser is required for this verification'}
$listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
$browserProfile=Join-Path $root ('browser-verification-'+[Guid]::NewGuid().ToString('N'))
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$BrowserPath
$info.Arguments='--headless=new --disable-gpu --remote-debugging-address=127.0.0.1 --remote-debugging-port='+$port+' --user-data-dir="'+$browserProfile+'" --no-first-run --no-default-browser-check about:blank'
$info.UseShellExecute=$false;$info.CreateNoWindow=$true
$browser=[Diagnostics.Process]::Start($info)
try {
 $ready=$false
 for($i=0;$i -lt 45;$i++){
  Start-Sleep -Seconds 1
  try{$r=Invoke-WebRequest ('http://127.0.0.1:'+$port+'/json/version') -UseBasicParsing -TimeoutSec 2;if($r.StatusCode -eq 200){$ready=$true;break}}catch{}
 }
 if(!$ready){throw 'Isolated Windows browser did not become ready'}
 $env:FILE_BRIDGE_BROWSER_MODE='headless on actual Windows host'
 & $node (Join-Path $PSScriptRoot 'browser-windows.cjs') $port 2>&1 | Out-File (Join-Path $artifacts 'windows-browser-native.log') -Encoding utf8
 if($LASTEXITCODE -ne 0){throw 'Actual Windows browser functional verification failed'}
 @{passed=$true;user=[Environment]::UserName;finishedAt=(Get-Date).ToString('o')}|ConvertTo-Json|Set-Content (Join-Path $artifacts 'windows-all-checks.json')
} catch {$_|Out-String|Set-Content (Join-Path $artifacts 'windows-browser-harness-error.txt');exit 1}
finally {if(!$browser.HasExited){$browser.Kill();$browser.WaitForExit(10000)|Out-Null}}
