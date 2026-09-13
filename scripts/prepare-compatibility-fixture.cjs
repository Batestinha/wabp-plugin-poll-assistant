const assert = require('node:assert/strict');
const { createHash, createPublicKey, verify } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const lock = require('../tests/forward-release.lock.json');

async function main() {
  const cache = path.join(root, '.cache');
  fs.mkdirSync(cache, { recursive: true });
  const file = path.join(cache, 'forward-poll-0.5.0.tgz');
  let bytes;
  if (fs.existsSync(file)) bytes = fs.readFileSync(file);
  else {
    let url = new URL(lock.url);
    let response;
    for (let redirect = 0; redirect <= 5; redirect++) {
      assert.equal(url.protocol, 'https:');
      response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
      if (response.status >= 300 && response.status < 400) {
        const next = response.headers.get('location');
        assert.ok(next, 'Missing redirect target');
        url = new URL(next, url); await response.body?.cancel(); continue;
      }
      assert.ok(response.ok, `Forward fixture download failed: ${response.status}`);
      break;
    }
    assert.ok(response?.ok);
    const chunks = []; let count = 0;
    for await (const chunk of response.body) {
      count += chunk.length;
      assert.ok(count <= 2*1024*1024, 'Forward fixture exceeds its download budget');
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), lock.sha256);
  assert.ok(verify(null, Buffer.from(lock.sha256), createPublicKey({ key: Buffer.from(lock.publicKeyDerBase64, 'base64'),
    format: 'der', type: 'spki' }), Buffer.from(lock.signatureBase64, 'base64')), 'Invalid pinned forward signature');
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes, { flag: 'wx' });
  const script = `from pathlib import Path
import hashlib,json,os,tarfile,tempfile
root=Path('.cache').resolve()
destination=root/'forward-poll-0.5.0'
with tarfile.open(root/'forward-poll-0.5.0.tgz') as archive:
 members=archive.getmembers()
 assert len(members)<=10000 and sum(m.size for m in members)<=64*1024**2
 names=set()
 for member in members:
  assert member.isfile() or member.isdir()
  assert member.name.startswith('package/') and '..' not in Path(member.name).parts
  assert member.name not in names;names.add(member.name)
 if destination.exists():
  assert not destination.is_symlink()
  files=set()
  for path in destination.rglob('*'):
   assert not path.is_symlink()
   if path.is_file():files.add(path.relative_to(destination).as_posix())
  assert files=={m.name for m in members if m.isfile()}
  for member in members:
   if member.isfile():assert (destination/member.name).read_bytes()==archive.extractfile(member).read()
 else:
  with tempfile.TemporaryDirectory(prefix='forward-fixture-',dir=root) as temporary:
   staging=Path(temporary)/'unpacked';staging.mkdir()
   archive.extractall(staging,filter='data')
   staging.rename(destination)
manifest=json.loads((destination/'package/wa-plugin.json').read_text())
assert manifest['pluginId']=='official.poll-assistant' and manifest['version']=='0.5.0'
print('Verified signed Poll 0.5.0 rollback fixture')
`;
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', script], { cwd: root, stdio: 'inherit', timeout: 60_000 });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
