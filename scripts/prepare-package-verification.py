"""Prepare a private ssh_execute request using fresh immutable GitHub download URLs.
python scripts/prepare-package-verification.py /private/request.json --server MCP_SERVER
"""
import argparse,base64,hashlib,json,os,pathlib,subprocess
p=argparse.ArgumentParser();p.add_argument('output');p.add_argument('--server',required=True);a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];version=json.loads((root/'package.json').read_text())['version'];ref=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
output=pathlib.Path(a.output).resolve()
if output.is_relative_to(root):raise SystemExit('Temporary authorized URLs must remain outside the source repository')
files=[f'release/File-Bridge-{version}-windows-x64.zip','scripts/Verify-Package.ps1','scripts/verify-windows-package.cjs']
urls=[subprocess.check_output(['gh','api',f'repos/trlstdin/rororororo/contents/{f}?ref={ref}','--jq','.download_url'],text=True).strip() for f in files]
params={'ExpectedSha256':hashlib.sha256((root/files[0]).read_bytes()).hexdigest(),'PackageUrl':urls[0],'VerifierPsUrl':urls[1],'VerifierJsUrl':urls[2],'PackageVersion':version}
s=(root/'scripts/Install-Package-Verification.ps1').read_text();s=s[s.index('\n')+1:]
s='\n'.join('$'+k+"='"+v.replace("'","''")+"'" for k,v in params.items())+'\n'+s
request={'name':'ssh_execute','arguments':{'server':a.server,'command':'powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand '+base64.b64encode(s.encode('utf-16le')).decode(),'timeout':300000}}
fd=os.open(output,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:json.dump(request,f)
print('Prepared private verification request; temporary credentials omitted from output')
