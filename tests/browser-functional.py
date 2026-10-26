"""Exercise real browser storage, reload recovery and shared single-host pages."""
import base64,hashlib,json,os,pathlib,sys,uuid
from playwright.sync_api import sync_playwright
url=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig').strip()
cdp=sys.argv[2] if len(sys.argv)>2 else None
out=pathlib.Path(os.environ.get('FB_SCREENSHOT_DIR',str(pathlib.Path(__file__).resolve().parents[1]/'docs/screenshots')));out.mkdir(parents=True,exist_ok=True)
stamp=uuid.uuid4().hex[:6];file_name='断线续传测试-'+stamp+'.bin';text_a='离线文字：刷新后仍会继续发送。'+stamp;text_b='手机网页回执：同一个网址，无需配对。'+stamp
checks=[];errors=[]
def record(s):checks.append(s);print(s,flush=True)
try:
 with sync_playwright() as p:
  browser=p.chromium.connect_over_cdp(cdp) if cdp else p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--disable-setuid-sandbox'])
  desktop=browser.new_context(viewport={'width':1280,'height':1000},locale='zh-CN',timezone_id='Asia/Shanghai')
  mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,locale='zh-CN',timezone_id='Asia/Shanghai')
  a=desktop.new_page();b=mobile.new_page()
  for page in (a,b):page.on('pageerror',lambda e:errors.append(str(e)))
  a.goto(url,wait_until='networkidle',timeout=90000);b.goto(url,wait_until='networkidle',timeout=90000)
  assert a.locator('h1').inner_text()=='打开网页，就能传。'
  assert a.locator('#pairCode,#peers,#target').count()==0
  a.get_by_text('网页已连接',exact=True).wait_for(timeout=20000)
  record('Two independent browsers open the same URL with no device connection or pairing')
  desktop.set_offline(True);a.locator('#text').fill(text_a);a.locator('#sendText').click()
  a.locator('#queue').get_by_text('等待恢复后继续',exact=True).wait_for(timeout=20000)
  desktop.set_offline(False);a.reload(wait_until='networkidle');b.get_by_text(text_a,exact=True).wait_for(timeout=30000)
  record('Offline text survives browser reload and appears on the other shared page')
  b.locator('#text').fill(text_b);b.locator('#sendText').click()
  a.locator('#items').get_by_text(text_b,exact=True).wait_for(timeout=30000)
  record('Mobile page sends text back through the same single-host website')
  blocks={'zero':0,'aborted':False,'block':True}
  def route_chunk(route):
   i=int(route.request.url.rsplit('/',1)[-1])
   if i==0:blocks['zero']+=1
   if i==1 and blocks['block']:blocks['aborted']=True;route.abort()
   else:route.continue_()
  a.route('**/api/uploads/*/chunks/*',route_chunk)
  length=2*1024*1024+123
  a.evaluate('''({length,name})=>{const bytes=new Uint8Array(length);for(let i=0;i<length;i++)bytes[i]=i%251;const dt=new DataTransfer();dt.items.add(new File([bytes],name,{type:'application/octet-stream'}));const input=document.querySelector('#file');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));}''',{'length':length,'name':file_name})
  a.locator('#sendFile').click();entry=a.locator('#queue .entry').filter(has_text=file_name)
  entry.get_by_text('等待恢复后继续',exact=True).wait_for(timeout=45000);assert blocks['aborted']
  blocks['block']=False;a.reload(wait_until='networkidle');entry=a.locator('#queue .entry').filter(has_text=file_name);entry.get_by_text('主机已保存',exact=True).wait_for(timeout=90000)
  assert blocks['zero']==1,blocks
  record('File and manifest survive reload; confirmed first chunk is not uploaded again')
  b.get_by_role('link',name='下载：'+file_name,exact=True).wait_for(timeout=30000)
  actual=b.evaluate('''async(name)=>{const a=Array.from(document.querySelectorAll('#items a')).find(a=>a.textContent==='下载：'+name);const r=await fetch(a.href);if(!r.ok)throw Error('download failed');const bytes=await r.arrayBuffer();const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');return {length:bytes.byteLength,digest,attachment:r.headers.get('content-disposition')}}''',file_name)
  expected=bytes(i%251 for i in range(length));assert actual['length']==length;assert actual['digest']==hashlib.sha256(expected).hexdigest();assert actual['attachment'].startswith('attachment;')
  record('Other browser downloads the complete file; every byte verified through its full digest')
  file_item=a.locator('#items .item').filter(has_text='下载：'+file_name);file_item.get_by_role('button',name='归档到主机').click();file_item.get_by_text('已归档',exact=True).wait_for()
  a.locator('#archiveTab').click();a.get_by_role('link',name='下载：'+file_name,exact=True).wait_for();a.reload(wait_until='networkidle');a.locator('#archiveTab').click();a.get_by_role('link',name='下载：'+file_name,exact=True).wait_for();a.locator('#recentTab').click()
  record('Archived content remains accessible after page reload')
  png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII='
  a.locator('#file').set_input_files({'name':'图片测试.png','mimeType':'image/png','buffer':base64.b64decode(png)});a.locator('#sendFile').click();b.locator('img[alt="图片测试.png"]').wait_for(timeout=30000);b.wait_for_function('document.querySelector(\'img[alt="图片测试.png"]\').naturalWidth===1')
  assert a.evaluate('document.documentElement.scrollWidth<=innerWidth');assert b.evaluate('document.documentElement.scrollWidth<=innerWidth');assert not errors,errors
  record('Image preview and mobile layout work without JavaScript errors or horizontal overflow')
  a.screenshot(path=str(out/'single-host-desktop.png'),full_page=True);b.screenshot(path=str(out/'single-host-mobile.png'),full_page=True)
  result={'passed':True,'browser_platform':'remote Windows Chromium via CDP' if cdp else 'Linux Chromium','checks':checks,'javascript_errors':errors};(out.parent/'BROWSER-RESULT.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
  desktop.close();mobile.close()
  if not cdp:browser.close()
except Exception as e:
 print(type(e).__name__+': '+str(e).replace(url,'[private website URL]'),file=sys.stderr);raise SystemExit(1)
