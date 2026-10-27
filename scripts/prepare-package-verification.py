"""Prepare a private ssh_execute request using fresh immutable GitHub download URLs.
python scripts/prepare-package-verification.py /private/request.json --server MCP_SERVER
"""
import argparse,base64,hashlib,json,os,pathlib,subprocess,urllib.request,urllib.error,urllib.parse
p=argparse.ArgumentParser();p.add_argument('output');p.add_argument('--server',required=True);p.add_argument('--resume-existing',action='store_true');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];version=json.loads((root/'package.json').read_text())['version'];ref=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
output=pathlib.Path(a.output).resolve()
if output.is_relative_to(root):raise SystemExit('Temporary authorized URLs must remain outside the source repository')
file=f'release/File-Bridge-{version}-windows-x64.zip'
url=subprocess.check_output(['gh','api',f'repos/trlstdin/rororororo/contents/{file}?ref={ref}','--jq','.download_url'],text=True).strip()
# Prefer GitHub's resource-scoped release-asset redirect when the draft asset exists.
# Credentials are sent only to api.github.com; only the temporary signed asset URL reaches Windows.
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,req,fp,code,msg,headers,newurl):return None
try:
 release=json.loads(subprocess.check_output(['gh','release','view','file-bridge-v'+version,'--repo','trlstdin/rororororo','--json','assets'],text=True))
 asset=next(x for x in release['assets'] if x['name']==pathlib.Path(file).name)
 api=asset['apiUrl'];assert api.startswith('https://api.github.com/repos/trlstdin/rororororo/releases/assets/')
 credential=os.environ.get('GH_TOKEN')
 if credential:
  request=urllib.request.Request(api,headers={'Accept':'application/octet-stream','Authorization':'token '+credential},method='HEAD')
  try:urllib.request.build_opener(NoRedirect()).open(request,timeout=30).close()
  except urllib.error.HTTPError as e:
   signed=e.headers.get('Location','');host=urllib.parse.urlparse(signed).hostname
   if e.code==302 and signed.startswith('https://') and host in ['release-assets.githubusercontent.com','objects.githubusercontent.com']:url=signed
except (subprocess.CalledProcessError,StopIteration,urllib.error.URLError,KeyError):pass
params={'ExpectedSha256':hashlib.sha256((root/file).read_bytes()).hexdigest(),'PackageUrl':url,'VerifierPsBase64':base64.b64encode((root/'scripts/Verify-Package.ps1').read_bytes()).decode(),'VerifierJsBase64':base64.b64encode((root/'scripts/verify-windows-package.cjs').read_bytes()).decode(),'PackageVersion':version,'ResumeExisting':a.resume_existing}
s=(root/'scripts/Install-Package-Verification.ps1').read_text();s=s[s.index('\n')+1:]
s='\n'.join('$'+k+('=$true' if v is True else '=$false' if v is False else "='"+v.replace("'","''")+"'") for k,v in params.items())+'\n'+s
request={'name':'ssh_execute','arguments':{'server':a.server,'command':'powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand '+base64.b64encode(s.encode('utf-16le')).decode(),'timeout':300000}}
fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(request,f)
print('Prepared private verification request; temporary credentials omitted from output')
