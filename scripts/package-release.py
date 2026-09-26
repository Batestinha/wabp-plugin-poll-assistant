"""Normalize a locked npm runtime closure into an immutable WABS archive."""
from pathlib import Path
import gzip
import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile


def build_release():
    root = Path(__file__).resolve().parents[1]
    package = json.loads((root / 'package.json').read_text(encoding='utf-8'))
    manifest = json.loads((root / 'wa-plugin.json').read_text(encoding='utf-8'))
    provenance = json.loads((root / 'provenance.json').read_text(encoding='utf-8'))
    if hashlib.sha256((root / provenance['sdk']['path']).read_bytes()).hexdigest() != provenance['sdk']['sha256']:
        raise ValueError('Pinned SDK provenance mismatch')
    if manifest['version'] != package['version']:
        raise ValueError('Package and manifest versions differ')
    runtime_version = subprocess.run(
        ['node', '-e', 'process.stdout.write(require("./dist/index.js").default.manifest.version)'],
        cwd=root, capture_output=True, text=True, encoding='utf-8', check=True
    ).stdout
    if runtime_version != package['version']:
        raise ValueError('Compiled runtime manifest version differs from package version')
    contracts = json.loads((root / provenance['vendoredContracts']).read_text(encoding='utf-8'))
    for contract in contracts['contracts']:
        expected = contract['upstreamSha256']
        if contract['patches'] or contract['vendoredSha256'] != expected:
            raise ValueError('Unexpected contract patch or provenance mismatch')
        for base in [root / 'contracts', root / 'src/contracts']:
            if hashlib.sha256((base / contract['vendoredPath']).read_bytes()).hexdigest() != expected:
                raise ValueError('Vendored service contract differs from verified upstream bytes')
    cache = root / '.cache'
    cache.mkdir(exist_ok=True)
    npm = 'npm.cmd' if os.name == 'nt' else 'npm'
    with tempfile.TemporaryDirectory(prefix='wabs-release-') as temporary:
        result = subprocess.run([npm, 'pack', '--ignore-scripts', '--pack-destination', temporary, '--json'], cwd=root,
                                capture_output=True, text=True, encoding='utf-8', check=True)
        info = json.loads(result.stdout)[0]
        files = {}
        with tarfile.open(Path(temporary) / info['filename'], 'r:gz') as archive:
            for member in archive.getmembers():
                if not member.isfile() or member.name in files:
                    raise ValueError('Unexpected non-file or duplicate archive entry')
                if '..' in Path(member.name).parts or not member.name.startswith('package/') or '\\' in member.name:
                    raise ValueError('Unsafe archive entry')
                files[member.name] = archive.extractfile(member).read()
        for required in ['package/dist/index.js', 'package/wa-plugin.json',
                         'package/node_modules/@wabs/plugin-sdk/dist/command-plugin.js',
                         'package/node_modules/@wabs/plugin-sdk/LICENSE',
                         'package/node_modules/zod/LICENSE']:
            if required not in files:
                raise ValueError('Missing runtime file: ' + required)
        for name, expected in [('@wabs/plugin-sdk', provenance['sdk']['version']), ('zod', '3.25.76')]:
            if json.loads(files['package/node_modules/' + name + '/package.json'])['version'] != expected:
                raise ValueError('Installed dependency differs from locked provenance')
        input_tree = json.dumps({name: hashlib.sha256(data).hexdigest() for name, data in files.items()},
                                sort_keys=True, separators=(',', ':')).encode()
        files['package/packaging.json'] = (json.dumps({'schemaVersion': 1,
            'inputTreeSha256': hashlib.sha256(input_tree).hexdigest(), 'omittedUnusedFiles': {}},
            sort_keys=True, indent=2) + '\n').encode()
        target = cache / (manifest['pluginId'] + '-' + package['version'] + '.tgz')
        with target.open('wb') as raw:
            with gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=9) as compressed:
                with tarfile.open(fileobj=compressed, mode='w', format=tarfile.USTAR_FORMAT) as archive:
                    for name, data in sorted(files.items()):
                        header = tarfile.TarInfo(name)
                        header.size = len(data)
                        header.mode = 0o644
                        header.mtime = 0
                        header.uid = header.gid = 0
                        archive.addfile(header, io.BytesIO(data))
        if target.stat().st_size > 50 * 1024 * 1024:
            raise ValueError('Release exceeds WABP archive download budget')
        print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size,
                          'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'files': len(files)}))


if __name__ == '__main__':
    build_release()
