"""Multi-source UX, offline snapshot, source filtering and exact stable pixel checks.
Usage: python tests/browser-sources.py /private/url.txt [artifact-directory]
The equality comparison uses two captures of the same settled state, not a design reference.
"""
import json,pathlib,sys,uuid
from playwright.sync_api import sync_playwright
from PIL import Image,ImageChops
url=pathlib.Path(sys.argv[1]).read_text(encoding='utf-8-sig').strip()
out=pathlib.Path(sys.argv[2] if len(sys.argv)>2 else 'artifacts/sources');out.mkdir(parents=True,exist_ok=True)
checks=[]
def record(s):checks.append(s);print(s,flush=True)
with sync_playwright() as p:
 browser=p.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--disable-setuid-sandbox'])
 contexts=[browser.new_context(viewport={'width':1280,'height':1000},locale='zh-CN',timezone_id='Asia/Shanghai'),browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,locale='zh-CN',timezone_id='Asia/Shanghai')]
 a,b=[c.new_page() for c in contexts]; errors=[]
 for page in (a,b):
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.goto(url,wait_until='networkidle');page.wait_for_function('!document.querySelector("#sendText").disabled')
 def name(page,value):
  page.locator('#sourceName').fill(value);page.locator('#sourceForm button').click()
  page.locator('#notice').filter(has_text='来源名称已保存').wait_for()
 name(a,'办公室主机');name(b,'家中主机')
 id_a=a.evaluate('JSON.parse(localStorage.getItem("file-bridge-source")).id');id_b=b.evaluate('JSON.parse(localStorage.getItem("file-bridge-source")).id')
 assert id_a!=id_b
 stamp=uuid.uuid4().hex[:6];text_a='办公室待办 '+stamp;text_b='家中资料 '+stamp
 contexts[0].set_offline(True);a.locator('#text').fill(text_a);a.locator('#sendText').click()
 a.locator('#queue').get_by_text('等待恢复后继续',exact=True).wait_for()
 name(a,'办公室新名称')
 contexts[0].set_offline(False);a.reload(wait_until='networkidle')
 assert a.locator('#sourceName').input_value()=='办公室新名称'
 b.locator('#items .item').filter(has_text=text_a).wait_for()
 assert '办公室主机' in b.locator('#items .item').filter(has_text=text_a).inner_text()
 b.locator('#text').fill(text_b);b.locator('#sendText').click();a.locator('#items .item').filter(has_text=text_b).wait_for()
 record('Two independent browser sources share one website; offline queued origin remains unchanged after rename and reload')
 filename='同名文件-'+stamp+'.txt';payload=b'identical bytes from different sources'
 for page in (a,b):
  page.locator('#file').set_input_files({'name':filename,'mimeType':'text/plain','buffer':payload});page.locator('#sendFile').click()
  page.locator('#queue .entry').filter(has_text=filename).get_by_text('主机已保存',exact=True).wait_for()
 a.wait_for_function('(name)=>Array.from(document.querySelectorAll("#items a")).filter(a=>a.textContent==="下载："+name).length===2',arg=filename)
 assert a.locator('#items .item').filter(has_text=filename).count()==2
 for page,identity,expected,other in [(a,id_a,text_a,text_b),(b,id_b,text_b,text_a)]:
  page.locator('#sourceFilter').select_option(identity)
  page.locator('#items .item').filter(has_text=expected).wait_for()
  assert page.locator('#items .item').filter(has_text=other).count()==0
  assert page.locator('#items .item').filter(has_text=filename).count()==1
  item=page.locator('#items .item').filter(has_text=filename)
  data=page.evaluate('''async(name)=>{const a=Array.from(document.querySelectorAll('#items a')).find(a=>a.textContent==='下载：'+name);return await (await fetch(a.href)).text()}''',filename)
  assert data==payload.decode()
 record('Identical filenames and bytes from separate sources produce distinct saved records; filtering and downloads match the source')
 a.locator('#items .item').filter(has_text=filename).get_by_role('button',name='归档到主机').click()
 a.locator('#archiveTab').click();a.locator('#items .item').filter(has_text=filename).wait_for()
 assert '办公室新名称' in a.locator('#items').inner_text()
 a.locator('#sourceFilter').select_option(id_b);a.get_by_text('此来源暂无内容',exact=True).wait_for()
 record('Archive keeps the upload source and source filters work in both tabs, including empty results')
 a.locator('#recentTab').click();a.locator('#sourceFilter').select_option('*');b.locator('#sourceFilter').select_option('*')
 for page in (a,b):
  page.wait_for_function('(name)=>Array.from(document.querySelectorAll("#items a")).filter(a=>a.textContent==="下载："+name).length===2',arg=filename)
  assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
  page.evaluate('document.activeElement.blur()')
  page.wait_for_timeout(300)
 for label,page in [('desktop',a),('mobile',b)]:
  page.screenshot(path=str(out/(label+'.png')),full_page=True,animations='disabled',caret='hide')
  page.screenshot(path=str(out/(label+'-repeat.png')),full_page=True,animations='disabled',caret='hide')
  im1,im2=Image.open(out/(label+'.png')).convert('RGB'),Image.open(out/(label+'-repeat.png')).convert('RGB')
  assert im1.size==im2.size
  diff=ImageChops.difference(im1,im2);pixels=diff.tobytes();count=sum(1 for i in range(0,len(pixels),3) if pixels[i:i+3]!=bytes(3))
  assert count==0,(label,count)
  record(label+' repeated stable screenshot: 0 changed pixels')
 assert not errors,errors
 (out/'result.json').write_text(json.dumps({'passed':True,'checks':checks,'javascript_errors':errors,'pixel_comparison':'same settled state repeat captures; no supplied design reference','platform':'Linux Chromium'},ensure_ascii=False,indent=2))
 browser.close()
