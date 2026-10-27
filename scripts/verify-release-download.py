"""Download the exact private GitHub release asset and verify SHA-256 and attachment headers."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
root=Path(__file__).resolve().parents[1];version=json.loads((root/'package.json').read_text())['version'];name=f'File-Bridge-{version}-windows-x64.zip';tag='file-bridge-v'+version;repo='trlstdin/rororororo'
with tempfile.TemporaryDirectory(prefix='file-bridge-download-') as temp:
 subprocess.run(['gh','release','download',tag,'--repo',repo,'--pattern',name,'--dir',temp],check=True)
 assert hashlib.sha256((root/'release'/name).read_bytes()).digest()==hashlib.sha256((Path(temp)/name).read_bytes()).digest()
 d=json.loads(subprocess.check_output(['gh','release','view',tag,'--repo',repo,'--json','assets,isDraft'],text=True));assert not d['isDraft']
 asset=next(x for x in d['assets'] if x['name']==name)
 headers=subprocess.check_output(['gh','api','--method','HEAD','--include','-H','Accept: application/octet-stream',asset['apiUrl']],text=True)
 disposition=next(line for line in headers.splitlines() if line.lower().startswith('content-disposition:'))
 assert 'attachment' in disposition.lower() and name in disposition
 print(json.dumps({'passed':True,'version':version,'download_sha256_matches':True,'content_disposition':disposition.split(':',1)[1].strip(),'bytes':asset['size']}))
