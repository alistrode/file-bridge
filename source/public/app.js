(() => {
  const token = new URLSearchParams(location.search).get('token') || document.cookie.match(/(?:^|; )fileBridgeToken=([^;]+)/)?.[1] || '';
  const headers = () => ({'x-file-bridge-token': decodeURIComponent(token)});
  const items = document.querySelector('#items'), notice = document.querySelector('#notice'), fileInput = document.querySelector('#file'), fileName = document.querySelector('#fileName'), bar = document.querySelector('#bar'), sendFile = document.querySelector('#sendFile'), dropZone = document.querySelector('#dropZone'); let pendingFile = null;
  const esc = s => { const d=document.createElement('div'); d.textContent=s; return d.innerHTML; };
  const size = n => n > 1048576 ? (n/1048576).toFixed(1)+' MB' : (n/1024).toFixed(1)+' KB';
  const show = s => { notice.textContent=s; setTimeout(()=>notice.textContent='',4000); };
  async function load(){ const r=await fetch('/api/items',{headers:headers()}); if(!r.ok)return; const data=await r.json(); items.innerHTML=data.items.length?data.items.map(x=>{const href=x.kind==='text'?'':`${x.download}?token=${encodeURIComponent(token)}`;return `<div class="item" data-id="${x.id}">${x.kind==='text'?esc(x.text):`<a href="${href}">下载：${esc(x.name)}</a> <span class="muted">${size(x.size)}</span>${x.kind==='image'?`<img src="${href}" alt="${esc(x.name)}">`:''}`}<br><time>${new Date(x.createdAt).toLocaleString()}</time> <button class="archive" data-id="${x.id}">归档到电脑</button></div>`}).join(''):'暂无内容。'; }
  document.querySelector('#sendText').onclick=async()=>{const v=document.querySelector('#text').value;if(!v.trim())return;const r=await fetch('/api/text',{method:'POST',headers:{...headers(),'content-type':'text/plain'},body:v});if(r.ok){document.querySelector('#text').value='';show('文字已发送');load()}else show('发送失败')};
  items.onclick=async e=>{const b=e.target.closest('.archive');if(!b)return;b.disabled=true;const r=await fetch('/api/archive/'+encodeURIComponent(b.dataset.id),{method:'POST',headers:headers()});if(r.ok)b.textContent='已永久归档';else{b.disabled=false;show('归档失败')}};
  fileInput.onchange=()=>{const f=fileInput.files[0];fileName.textContent=f?`${f.name} · ${size(f.size)}`:'未选择文件';if(!f)return;if(f.size>1073741824)return show('文件超过 1 GB');const x=new XMLHttpRequest();x.open('POST','/api/file');Object.entries(headers()).forEach(([k,v])=>x.setRequestHeader(k,v));x.setRequestHeader('x-file-name',encodeURIComponent(f.name));x.setRequestHeader('content-type',f.type||'application/octet-stream');x.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=(e.loaded/e.total*100)+'%'};x.onload=()=>{bar.style.width='0';if(x.status<300){show('文件已发送');load()}else show('上传失败')};x.send(f)};
  const uploadDropped = file => {
    if (!file || file.size > 1073741824) return show('文件超过 1 GB');
    fileName.textContent = `${file.name} · ${size(file.size)}`;
    const x = new XMLHttpRequest(); x.open('POST','/api/file');
    Object.entries(headers()).forEach(([k,v])=>x.setRequestHeader(k,v));
    x.setRequestHeader('x-file-name',encodeURIComponent(file.name)); x.setRequestHeader('content-type',file.type||'application/octet-stream');
    x.upload.onprogress=e=>{if(e.lengthComputable)bar.style.width=(e.loaded/e.total*100)+'%'};
    x.onload=()=>{bar.style.width='0';if(x.status<300){show('文件已发送');fileName.textContent='未选择文件';load()}else show('上传失败')}; x.onerror=()=>show('网络中断，上传失败'); x.send(file);
  };
  fileInput.onchange=()=>{pendingFile=fileInput.files[0]||null;fileName.textContent=pendingFile?`${pendingFile.name} · ${size(pendingFile.size)}`:'未选择文件';sendFile.disabled=!pendingFile;};
  ['dragenter','dragover'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.add('dragover')}));
  ['dragleave','drop'].forEach(type=>dropZone.addEventListener(type,e=>{e.preventDefault();dropZone.classList.remove('dragover')}));
  dropZone.addEventListener('drop',e=>{pendingFile=e.dataTransfer.files[0]||null;fileName.textContent=pendingFile?`${pendingFile.name} · ${size(pendingFile.size)}`:'未选择文件';sendFile.disabled=!pendingFile;});
  sendFile.onclick=()=>{if(pendingFile){uploadDropped(pendingFile);sendFile.disabled=true;}};
  load();setInterval(load,4000);
})();
