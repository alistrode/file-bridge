import json,pathlib,urllib.request,time,hashlib,base64,sys
from playwright.sync_api import sync_playwright
root=pathlib.Path(__file__).resolve().parents[1];profiles={'a':pathlib.Path(sys.argv[1]),'b':pathlib.Path(sys.argv[2])};runtime={k:json.loads((v/'runtime.json').read_text())for k,v in profiles.items()}
def api(k,route,data=None):
 r=runtime[k];headers={'x-file-bridge-token':r['token'],'x-file-bridge-request':'1','Content-Type':'application/json'};req=urllib.request.Request(r['origin']+'/api/'+route,headers=headers,data=None if data is None else json.dumps(data).encode());return json.load(urllib.request.urlopen(req,timeout=100))
def until(fn,timeout=60):
 end=time.time()+timeout
 while time.time()<end:
  value=fn()
  if value:return value
  time.sleep(.3)
 raise AssertionError('Functional condition timed out')
checks=[];code=api('b','pair/create',{})['code'];bid=api('b','status')['identity']['id'];aid=api('a','status')['identity']['id']
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,chromium_sandbox=True,args=['--disable-setuid-sandbox','--disable-features=Translate']);page=browser.new_page(viewport={'width':1280,'height':1000},locale='zh-CN');errors=[];page.on('pageerror',lambda e:errors.append(str(e)));page.goto(runtime['a']['origin']+'/?token='+runtime['a']['token']);page.locator('#pairCode').fill(code);page.locator('#join').click();until(lambda:any(x['id']==bid and x['online'] for x in api('a','status')['peers']));page.wait_for_timeout(2200);checks.append('UI pairing over public WSS and remembered reciprocal identity')
 page.locator('#target').select_option(bid);page.locator('#text').fill('来自 File Bridge 网页的双向传输测试');page.locator('#textForm button').click();until(lambda:any(i.get('text')=='来自 File Bridge 网页的双向传输测试' for i in api('b','status')['items']));checks.append('UI UTF-8 text send and receiver confirmation')
 payload=b'File Bridge browser upload\x00'+bytes(range(256))*300;page.locator('#file').set_input_files({'name':'网页传输测试.bin','mimeType':'application/octet-stream','buffer':payload});page.locator('#sendFile').click();item=until(lambda:next((i for i in api('b','status')['items']if i.get('name')=='网页传输测试.bin'),None));assert hashlib.sha256(payload).hexdigest()==item['digest'];assert (profiles['b']/item['file']).read_bytes()==payload;checks.append('UI binary file send verified byte for byte')
 api('b','text',{'peerId':aid,'text':'另一端已收到文件，双向连接正常。'});until(lambda:any(i.get('text')=='另一端已收到文件，双向连接正常。' for i in api('a','status')['items']));page.locator('#requestOpen').click();request=until(lambda:next((i for i in api('b','status')['items']if i['type']=='open'and i['status']=='pending'),None));api('b','open/reject',{'id':request['id']});checks.append('UI request remote browser and receiver rejection')
 req=api('b','open/request',{'peerId':aid});until(lambda:any(i['id']==req['id']for i in api('a','status')['items']));page.wait_for_timeout(2200);page.locator('[data-accept="'+req['id']+'"]').click();until(lambda:any(i['id']==req['id']and i['status']=='accepted'for i in api('a','status')['items']));checks.append('UI receiver consents to opening local dashboard')
 assert not errors,errors;page.wait_for_timeout(1000);page.screenshot(path=str(root/'docs/screenshots/linux-connected-functional.png'),full_page=True);assert page.evaluate('document.documentElement.scrollWidth<=innerWidth');browser.close()
result={'passed':True,'platform':'Linux Chromium against native desktop backend','checks':checks,'javascript_errors':errors};(root/'docs/BROWSER-FUNCTIONAL.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps(result,ensure_ascii=False))
