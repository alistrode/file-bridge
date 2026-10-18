const { spawn } = require('child_process');
const http = require('http');
const token = 'persistence-test-token';
const root = __dirname;
function start() { return spawn(process.execPath, ['server.js'], {cwd:root, env:{...process.env, PORT:'8792', FILE_BRIDGE_TOKEN:token}, stdio:'ignore'}); }
function request(path, method='GET', body='') { return new Promise((resolve,reject)=>{ const r=http.request({hostname:'127.0.0.1',port:8792,path,method,headers:{'x-file-bridge-token':token,'content-type':'text/plain','content-length':Buffer.byteLength(body)}},res=>{let b='';res.on('data',c=>b+=c);res.on('end',()=>resolve({status:res.statusCode,body:b}));});r.on('error',reject);r.end(body);}); }
(async()=>{let p=start();await new Promise(r=>setTimeout(r,700));await request('/api/text','POST','restart-proof');p.kill();await new Promise(r=>setTimeout(r,300));p=start();await new Promise(r=>setTimeout(r,700));const out=await request('/api/items');const data=JSON.parse(out.body);const item=data.items.find(x=>x.text==='restart-proof');if(out.status!==200||!item)throw Error('persistence failed');const ar=await request('/api/archive/'+item.id,'POST');if(ar.status!==201)throw Error('archive failed');console.log('PERSISTENCE_AND_ARCHIVE_OK');p.kill();})().catch(e=>{console.error(e);process.exitCode=1});
