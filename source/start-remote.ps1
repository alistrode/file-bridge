param(
  [int]$Port = 8790,
  [int]$MinReconnectSeconds = 90
)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSCommandPath
$tokenFile = Join-Path $root 'data\token.txt'
$lockFile = Join-Path $root 'file-bridge.lock'
$urlFile = Join-Path $root 'current-url.txt'

# Acquire a process-wide mutex immediately so rapid repeat clicks cannot race
# before the PID lock file is written.
$mutex = New-Object System.Threading.Mutex($false, 'Local\FileBridge-8790')
$hasMutex = $false
try { $hasMutex = $mutex.WaitOne(0, $false) } catch { $hasMutex = $false }
if (-not $hasMutex) { exit 0 }

function Test-AlreadyRunning {
  if (Test-Path -LiteralPath $lockFile) {
    $pidText = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($pidText -match '^\d+$') {
      if (Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue) { return $true }
    }
  }
  return $false
}

if (Test-AlreadyRunning) { exit 0 }

try {
  $node = (Get-Command node -ErrorAction Stop).Source
  $cloudflared = (Get-Command cloudflared -ErrorAction Stop).Source
  Remove-Item Env:FILE_BRIDGE_TOKEN -ErrorAction SilentlyContinue
  $env:PORT = "$Port"
  $server = Start-Process -FilePath $node -ArgumentList 'server.js' -WorkingDirectory $root -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2

$token = ''
for ($i = 0; $i -lt 10 -and [string]::IsNullOrWhiteSpace($token); $i++) {
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $tokenFile) { $token = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
}
if ([string]::IsNullOrWhiteSpace($token)) { throw 'token file was not created' }
if (-not (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) { throw 'local server exited' }

Set-Content -LiteralPath $lockFile -Value ([string]$PID) -Encoding UTF8
$reconnectDelay = [Math]::Max(90, $MinReconnectSeconds)
try {
  while (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) {
    # Each tunnel attempt gets fresh logs, so an expired URL from an earlier
    # run can never be mistaken for the newly created tunnel.
    $out = Join-Path $env:TEMP "file-bridge-tunnel-$PID.out.log"
    $err = Join-Path $env:TEMP "file-bridge-tunnel-$PID.err.log"
    Remove-Item -LiteralPath $out,$err -Force -ErrorAction SilentlyContinue
    $tunnel = Start-Process -FilePath $cloudflared -ArgumentList "tunnel --url http://127.0.0.1:$Port --no-autoupdate" -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
    $match = $null
    while (-not $match -and (Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue)) {
      Start-Sleep 1
      $match = Select-String -Path @($out,$err) -Pattern 'https://[-a-z0-9]+\.trycloudflare\.com' -ErrorAction SilentlyContinue | Select-Object -First 1
    }
    if ($match) {
      $url = "$($match.Matches[0].Value)?token=$([Uri]::EscapeDataString($token))"
      Set-Content -LiteralPath $urlFile -Value $url -Encoding UTF8
    }
    # Only reconnect after the current tunnel process has actually exited.
    while (Get-Process -Id $tunnel.Id -ErrorAction SilentlyContinue) { Start-Sleep 10 }
    if (Get-Process -Id $server.Id -ErrorAction SilentlyContinue) { Start-Sleep -Seconds $reconnectDelay }
  }
} finally {
  if (Test-Path -LiteralPath $lockFile) {
    $current = (Get-Content -LiteralPath $lockFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($current -eq ([string]$PID)) { Remove-Item -LiteralPath $lockFile -Force -ErrorAction SilentlyContinue }
  }
}
} finally {
  if ($hasMutex) { try { $mutex.ReleaseMutex() } catch {} }
  $mutex.Dispose()
}
