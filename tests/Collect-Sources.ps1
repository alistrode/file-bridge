$ErrorActionPreference='Stop'
$root='E:\xxm\file-bridge-single\dev'
$out=Join-Path $root 'artifacts\windows-browser'
$accepted=$false
for($i=0;$i -lt 90;$i++){
 $info=Get-ScheduledTaskInfo -TaskName 'FileBridge-Single-Browser-Final'
 $file=Get-Item ($out+'\result.json')
 $r=Get-Content $file.FullName -Raw -Encoding UTF8|ConvertFrom-Json
 if($file.LastWriteTime -ge $info.LastRunTime){
  if($r.passed -and $r.checks.Count -ge 10){$accepted=$true;break}
  if((Get-ScheduledTask -TaskName 'FileBridge-Single-Browser-Final').State -ne 'Running'){throw ('Windows browser verification failed: '+$r.error)}
 }
 Start-Sleep -Seconds 2
}
if(!$accepted){throw 'Current multi-source Windows browser checks are not complete'}
$paths=@('single-host-windows-desktop.png','single-host-windows-mobile.png','source-windows-desktop-repeat.png','source-windows-mobile-repeat.png','result.json') | ForEach-Object {Join-Path $out $_}
$zip=Join-Path $root 'artifacts\sources-verified.zip'
if(Test-Path $zip){Remove-Item $zip}
Compress-Archive -LiteralPath $paths -DestinationPath $zip
$s=New-Object -ComObject Schedule.Service;$s.Connect();$folder=$s.GetFolder('\')
$t=$folder.GetTask('FileBridge-Open-Normal-Browser');$def=$t.Definition;$def.Actions.Clear();$a=$def.Actions.Create(0)
$a.Path='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
$command="`$u=(Get-Content '$root\var\current-url.txt' -Raw).Trim();Start-Process 'C:\Program Files\Google\Chrome\Application\chrome.exe' -ArgumentList @('--new-window',`$u)"
$a.Arguments='-NoProfile -WindowStyle Hidden -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
$t=$folder.RegisterTaskDefinition('FileBridge-Open-Normal-Browser',$def,6,$null,$null,3);$t.Run($null)|Out-Null
@{passed=$r.passed;checks=$r.checks.Count;browser=$r.browser;website=(Invoke-RestMethod 'http://127.0.0.1:18791/health').version;artifactsReady=$true}|ConvertTo-Json
