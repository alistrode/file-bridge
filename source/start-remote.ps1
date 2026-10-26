param([int]$Port=8790,[string]$ProfileDir='',[string]$Cloudflared='cloudflared')
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $PSCommandPath
if([string]::IsNullOrWhiteSpace($ProfileDir)){$ProfileDir=Join-Path (Split-Path -Parent $root) 'var'}
$node=Join-Path (Split-Path -Parent $root) 'runtime\node.exe'
if(!(Test-Path $node)){$node=(Get-Command node -ErrorAction Stop).Source}
& $node (Join-Path $root 'host\cli.cjs') start --profile-dir $ProfileDir --port $Port --cloudflared $Cloudflared
exit $LASTEXITCODE
