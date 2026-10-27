"use strict";
const path = require('node:path'), cp = require('node:child_process');
const {request,open}=require('./cli.cjs');
(async()=>{
 const args=process.argv.slice(2), profile=path.resolve(args.includes('--profile-dir') ? args[args.indexOf('--profile-dir')+1] : path.join(__dirname,'../../var'));
 const started=cp.spawnSync(process.execPath,[path.join(__dirname,'cli.cjs'),'start',...args],{stdio:'inherit',windowsHide:true});
 if(started.error)throw started.error;if(started.status!==0)throw Error('Host startup failed');
 console.log('Waiting for the website address...');
 const end=Date.now()+120000;
 while(Date.now()<end){
  let s;
  try{s=await request(profile,'/status');}catch{await new Promise(r=>setTimeout(r,1000));continue;}
  if(s.url&&s.tunnelState==='online'||args.includes('off')&&s.localUrl){
   const url=s.url||s.localUrl;console.log('Website: '+url);
   const child=open(url);child.on('error',()=>console.log('Open the website address above in your browser.'));child.unref();return;
  }
  await new Promise(r=>setTimeout(r,1000));
 }
 throw Error('Tunnel is still connecting. Check var/logs or run Open-File-Bridge.cmd after the network recovers.');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
