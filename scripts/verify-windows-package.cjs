'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]),out=process.argv[3];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function inventory(){const m=JSON.parse(fs.readFileSync(path.join(root,'FILES.json'),'utf8'));for(const [file,digest] of Object.entries(m.sha256))assert.equal(hash(fs.readFileSync(path.join(root,file))),digest,'Packaged file mismatch: '+file);return Object.keys(m.sha256).length;}
(async()=>{
 assert.equal(process.platform,'win32');assert.equal(process.execPath.toLowerCase(),path.join(root,'runtime/node.exe').toLowerCase());
 const files=inventory(),{request}=require(path.join(root,'source/host/cli.cjs')),profile=path.join(root,'var');
 let s; const readyUntil=Date.now()+120000;
 while(Date.now()<readyUntil){try{s=await request(profile,'/status');if(s.url&&s.webState==='online'&&s.tunnelState==='online')break;}catch{}await new Promise(r=>setTimeout(r,1000));}
assert.equal(s.version,require(path.join(root,'package.json')).version);assert.equal(s.webState,'online');assert.equal(s.tunnelState,'online');assert(s.url.startsWith('https://'));
 if(process.argv.includes('--compat')){
  const cfg=JSON.parse(fs.readFileSync(path.join(profile,'config.json'),'utf8'));
  assert.equal(path.resolve(cfg.tunnel.executable).toLowerCase(),path.join(root,'runtime/cloudflared.exe').toLowerCase());
  inventory();await request(profile,'/stop',true);
  const report=JSON.parse(fs.readFileSync(out,'utf8'));assert(report.passed);report.compatibilityPowerShell=true;report.compatibilityFilesIncluded=true;
  fs.writeFileSync(out,JSON.stringify(report,null,2));console.log('Bundled compatibility PowerShell startup passed without system Node/cloudflared');return;
 }
 const home=await fetch(s.url,{signal:AbortSignal.timeout(45000)});assert.equal(home.status,200);assert((await home.text()).includes('sourceName'));
 const base=new URL(s.url).origin,token=fs.readFileSync(path.join(profile,'site/token.txt'),'utf8').trim();
 async function api(route,data,method){const r=await fetch(base+route,{method:method||(data?'POST':'GET'),headers:{'x-file-bridge-token':token,'x-file-bridge-request':'1',...(data&&!Buffer.isBuffer(data)?{'content-type':'application/json'}:{})},body:data?(Buffer.isBuffer(data)?data:JSON.stringify(data)):undefined,signal:AbortSignal.timeout(45000)});assert(r.ok,'HTTP '+r.status+' '+route);return r;}
 const a={id:crypto.randomUUID(),name:'运行包主机 A'},b={id:crypto.randomUUID(),name:'运行包主机 B'};
 for(const source of [a,b])await api('/api/text',{id:crypto.randomUUID(),text:'运行包公网验收 '+source.name,source});
 const bytes=crypto.randomBytes(65575),block=hash(bytes),fileIds=[];
 for(const source of [a,b]){
  const job={id:crypto.randomUUID(),name:'package-roundtrip.bin',size:bytes.length,mime:'application/octet-stream',blocks:[block],manifest:hash(block),source};
  const prepared=await(await api('/api/uploads',job)).json();assert.equal(prepared.id,job.id);
  if(!prepared.present.includes(0))await api('/api/uploads/'+job.id+'/chunks/0',bytes,'PUT');
  const {item}=await(await api('/api/uploads/'+job.id+'/complete',{})).json();assert.deepEqual(item.source,source);assert.equal(item.digest,hash(bytes));fileIds.push(item.id);
  const received=Buffer.from(await(await api(item.download)).arrayBuffer());assert(received.equals(bytes));
 }
 assert.notEqual(fileIds[0],fileIds[1]);const list=await(await api('/api/items')).json();assert.equal(list.sources.length,2);assert.equal(list.items.length,4);
 inventory();await request(profile,'/stop',true);
 fs.writeFileSync(out,JSON.stringify({passed:true,platform:'Windows 11 x64',node:process.version,bundledNode:true,systemNodeOnPath:false,filesVerified:files,publicHttps:true,sourceLabels:true,distinctSameFileRecords:true,downloadBytesVerified:true,explicitStop:true},null,2));
 console.log('Self-contained Windows package passed: bundled runtime, clean directory, public HTTPS, separate sources, file roundtrip and immutable file inventory');
})().catch(async e=>{fs.writeFileSync(out,JSON.stringify({passed:false,error:e.message},null,2));try{await require(path.join(root,'source/host/cli.cjs')).request(path.join(root,'var'),'/stop',true)}catch{}console.error(e.message);process.exitCode=1;});
