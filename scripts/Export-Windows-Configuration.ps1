# Capture the actual authorized host's useful task definitions and non-secret profile settings.
$ErrorActionPreference='Stop'
$root='E:\xxm\file-bridge-single\dev'
$out=Join-Path $root 'artifacts\configuration-export'
New-Item -ItemType Directory -Force $out|Out-Null
foreach($name in @('FileBridge-Single-Host','FileBridge-Single-Browser-Final','FileBridge-Open-Normal-Browser')){
 $xml=Export-ScheduledTask -TaskName $name
 # These definitions must use the private URL file, never embed a website access URL.
 if($xml -match '\?token='){throw 'A task definition includes an access credential'}
 $m=[regex]::Matches($xml,'-EncodedCommand\s+([A-Za-z0-9+/=]+)')
 foreach($entry in $m){$text=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($entry.Groups[1].Value));if($text -match '\?token='){throw 'Encoded task action includes an access credential'}}
 [IO.File]::WriteAllText((Join-Path $out ($name+'.xml')),$xml,[Text.Encoding]::Unicode)
}
$c=Get-Content ($root+'\var\config.json') -Raw|ConvertFrom-Json
# Explicit whitelist; access/control tokens and Cloudflare credentials are never read.
@{port=$c.port;tunnel=@{mode=$c.tunnel.mode;executable=$c.tunnel.executable}}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $out 'host-profile.json') -Encoding UTF8
$zip=Join-Path $root 'artifacts\configuration-export.zip'
if(Test-Path $zip){Remove-Item -LiteralPath $zip}
Compress-Archive -Path ($out+'\*') -DestinationPath $zip
@{exported=$true;taskDefinitions=3;privateCredentialsIncluded=$false}|ConvertTo-Json
