"""Check package completeness, source identity, skill indexes and optional pushed refs."""
import argparse,hashlib,json,pathlib,subprocess,zipfile
p=argparse.ArgumentParser();p.add_argument('--remote',action='store_true');a=p.parse_args()
root=pathlib.Path(__file__).resolve().parents[1];version=json.loads((root/'package.json').read_text())['version'];skill=(root/'.agents/skills/file-bridge/SKILL.md').read_text()
tracked=subprocess.check_output(['git','ls-files','-z'],cwd=root,text=True).split('\0');tracked=[f for f in tracked if f]
commands=[f for f in tracked if f.endswith(('.cmd','.sh','.ps1','.cjs','.py','.vbs')) or f.startswith('.github/workflows/')]
missing=[f for f in commands if f not in skill]
if missing:raise SystemExit('Missing skill command index: '+', '.join(missing))
archive=root/f'release/File-Bridge-{version}-windows-x64.zip'
with zipfile.ZipFile(archive) as z:
 prefix=f'File-Bridge-{version}-windows-x64/'
 names=[n for n in z.namelist() if not n.endswith('/')];assert all(n.startswith(prefix) for n in names)
 members={n[len(prefix):]:z.read(n) for n in names};manifest=json.loads(members['FILES.json'])
 assert set(manifest['sha256'])==set(members)-{'FILES.json'}
 for name,digest in manifest['sha256'].items():assert hashlib.sha256(members[name]).hexdigest()==digest,name
 required=[f for f in tracked if f.startswith('source/')]+[f for f in tracked if f.endswith('.cmd') and '/' not in f]+['package.json']
 for f in required:assert members.get(f)==(root/f).read_bytes(),'Missing or stale application/compatibility file: '+f
 for name in members:
  assert not any(part in ['var','data','received','archive','node_modules','tests','__pycache__'] for part in pathlib.PurePosixPath(name).parts),name
if a.remote:
 assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip(),'Uncommitted files remain'
 subprocess.run(['git','fetch','origin','refs/heads/projects/file-bridge:refs/remotes/origin/projects/file-bridge'],cwd=root,check=True)
 subprocess.run(['git','diff','--quiet','HEAD','origin/projects/file-bridge'],cwd=root,check=True)
print(json.dumps({'passed':True,'version':version,'indexed_command_files':len(commands),'matching_application_files':len(required),'verified_payload_files':len(manifest['sha256']),'package_bytes':archive.stat().st_size,'remote_verified':a.remote}))
