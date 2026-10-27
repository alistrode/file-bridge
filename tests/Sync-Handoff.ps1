param([Parameter(Mandatory=$true)][string]$SourceZip)
$ErrorActionPreference='Stop'
$root='E:\xxm\file-bridge-single\dev'
$stage=Join-Path $root ('handoff-sync-'+[Guid]::NewGuid().ToString('N'))
try{
 Expand-Archive -LiteralPath $SourceZip -DestinationPath $stage
 $env:FILE_BRIDGE_HANDOFF_STAGE=$stage
 $script=@'
const fs=require('fs'),path=require('path');const root='E:/xxm/file-bridge-single/dev',stage=process.env.FILE_BRIDGE_HANDOFF_STAGE,{atomic}=require(root+'/source/host/storage.cjs');function copy(src,dest){fs.mkdirSync(dest,{recursive:true});for(const e of fs.readdirSync(src,{withFileTypes:true})){const a=path.join(src,e.name),b=path.join(dest,e.name);if(e.isDirectory())copy(a,b);else atomic(b,fs.readFileSync(a));}}copy(stage+'/docs',root+'/docs');atomic(root+'/README.md',fs.readFileSync(stage+'/README.md'));
'@
 & 'C:\Program Files\nodejs\node.exe' -e $script
 if($LASTEXITCODE -ne 0){throw 'Final handoff synchronization failed'}
 'Final handoff and verified screenshots synchronized; live website was not restarted'
}finally{if(Test-Path $stage){Remove-Item -LiteralPath $stage -Recurse -Force}}
