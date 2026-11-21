"""Build the complete R42 Windows ZIP. Requires Python 3.11+ and Node.js 20+."""
import argparse
import gzip
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))
def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()
def verified(path, entry):
    return path.is_file() and path.stat().st_size == entry['bytes'] and sha(path) == entry['sha256']
def acquire(entry, local, cache):
    if local is not None and verified(local, entry):
        return local
    dest = cache / entry['sha256']
    if verified(dest, entry):
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=cache, delete=False) as temp:
        staged = Path(temp.name)
    try:
        with urllib.request.urlopen(entry['url'], timeout=180) as source, staged.open('wb') as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        if not verified(staged, entry):
            raise ValueError('Upstream checksum mismatch for ' + entry['path'])
        staged.replace(dest)
    finally:
        staged.unlink(missing_ok=True)
    return dest
def pack(package_dir, output, extras):
    sources = {f.relative_to(package_dir).as_posix(): f for f in package_dir.rglob('*') if f.is_file()}
    sources.update(extras)
    with output.open('wb') as raw, gzip.GzipFile(filename='', fileobj=raw, mode='wb', compresslevel=5, mtime=0) as gz:
        with tarfile.open(fileobj=gz, mode='w|', format=tarfile.PAX_FORMAT) as tar:
            for name, source in sorted(sources.items()):
                info = tarfile.TarInfo('package/' + name)
                info.size = source.stat().st_size
                info.mode = 0o755 if name.endswith(('.exe', '.node')) else 0o644
                with source.open('rb') as data:
                    tar.addfile(info, data)
def bundle(folder, output):
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=output.parent, delete=False) as temp:
        staged = Path(temp.name)
    try:
        with zipfile.ZipFile(staged, 'w', allowZip64=True) as archive:
            for f in sorted(folder.rglob('*')):
                if not f.is_file():
                    continue
                kind = zipfile.ZIP_STORED if f.suffix == '.tgz' else zipfile.ZIP_DEFLATED
                info = zipfile.ZipInfo(f.relative_to(folder).as_posix(), (2026, 11, 20, 0, 0, 0))
                info.compress_type = kind
                with f.open('rb') as source, archive.open(info, 'w', force_zip64=True) as dest:
                    shutil.copyfileobj(source, dest, 1024 * 1024)
        staged.replace(output)
    finally:
        staged.unlink(missing_ok=True)
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT/'dist/Yunshu-R42-Windows-x64.zip')
    parser.add_argument('--cache', type=Path, default=ROOT/'.build-cache')
    parser.add_argument('--bge-model', type=Path, help='Optional verified local model_int8.onnx')
    parser.add_argument('--speech-models', type=Path, help='Optional model directory containing silero and sensevoice-onnx')
    parser.add_argument('--background-music', type=Path, help='Personal build only: local MP3 soundtrack')
    parser.add_argument('--music-title', help='Display title for the personal soundtrack')
    args = parser.parse_args()
    if bool(args.background_music) != bool(args.music_title):
        parser.error('--background-music and --music-title must be provided together')
    if args.background_music and (args.background_music.suffix.lower() != '.mp3' or not args.background_music.is_file()):
        parser.error('The personal soundtrack must be a local MP3')
    args.cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=args.cache) as temp:
        stage = Path(temp)
        for f in (ROOT/'installer').iterdir():
            if f.is_file():
                shutil.copyfile(f, stage/f.name)
        shutil.copytree(ROOT/'licenses', stage/'licenses')
        for name in ['LICENSE', 'THIRD_PARTY_NOTICES.md']:
            shutil.copyfile(ROOT/name, stage/name)
        shutil.copyfile(ROOT/'README.md', stage/'README.md')
        packages = []
        if args.background_music:
            readme = stage/'README.md'
            readme.write_text(readme.read_text('utf8').replace('云舒的原创配乐《湖畔夜曲》', '个人配乐《' + args.music_title + '》'), 'utf8')
        for kind in ['desktop', 'united']:
            package_dir = ROOT/'packages'/kind
            package = read(package_dir/'package.json')
            tgz = stage/('yunshu-dsh-' + kind + '-' + package['version'] + '.tgz')
            extras = {r['path']: acquire(r, args.bge_model, args.cache) for r in read(ROOT/'vendor.lock.json') if r['package'] == kind}
            if kind == 'desktop' and args.background_music:
                client = (package_dir/'client.js').read_text('utf8')
                before = "' · 湖畔夜曲 · 云舒'"
                if client.count(before) != 1:
                    raise ValueError('Cannot locate the soundtrack title')
                personal_client = stage/'personal-client.js'
                personal_client.write_text(client.replace(before, json.dumps(' · ' + args.music_title, ensure_ascii=False)), 'utf8')
                extras.update({'client.js': personal_client, 'components/avalon/media/lake-nocturne.mp3': args.background_music})
            client_entry = extras.get('client.js', package_dir/'client.js')
            subprocess.run(['node', str(ROOT/'scripts/check-client.cjs'), str(client_entry), package['name']], check=True)
            pack(package_dir, tgz, extras)
            if kind == 'desktop' and args.background_music:
                personal_client.unlink()
            packages.append(dict(name=package['name'], version=package['version'], file=tgz.name, sha256=sha(tgz), bytes=tgz.stat().st_size))
        speech = read(ROOT/'speech.lock.json')
        for row in speech:
            local = args.speech_models/row['path'] if args.speech_models else None
            f = acquire(row, local, args.cache)
            dest = stage/'models'/row['path']
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(f, dest)
        manifest = dict(version='r42-personal' if args.background_music else 'r42-public', hostVersion='0.2.2-rc.1', packages=packages, speech=speech)
        (stage/'release-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n','utf8')
        bundle(stage, args.output)
    print(args.output, sha(args.output), flush=True)
if __name__ == '__main__':
    main()
