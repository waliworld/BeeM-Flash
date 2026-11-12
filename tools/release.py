#!/usr/bin/env python3
"""Lay out the MGU Store catalog of this repository in dist/release/: catalog.json, the app packages and the icon.
Upload every file of dist/release/ as an asset of a GitHub release tagged `catalog`; add this repository as a source
in the Store (Settings, Add source) and it offers Wali Datalog for install.

The app's package differs by head unit, because the Store's deploy tool supplies BMW's oap-sdk differently:
  iDrive 7: the OAP package WITHOUT node_modules/oap-sdk (the head unit generates that module from a donor app);
  iDrive 8: the app's SOURCE package (mgu-app.json; catalog "build": "unit"), which the head unit builds, linking the
            app's entry module against the oap-sdk of a donor app. An OAP package installs on iDrive 8 but never starts.

Build first:
    python3 kit/tools/build.py wali_datalog               # dist/wali_datalog@<v>.tgz + .mgu   (iDrive 7)
    python3 kit/tools/build.py --hmi ID8 wali_datalog     # dist/src/wali_datalog8@<v>.tgz       (iDrive 8)
Then:
    python3 tools/release.py [--repo owner/name] [--base URL] [--hmi ID7|ID8|both]

tools/release.sh does all of it. BMW's oap-sdk is in no uploaded file: the iDrive 7 package is stripped of it here,
and the iDrive 8 source package never contained it.
"""
import argparse, gzip, hashlib, io, json, os, shutil, sys, tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = 'waliworld/MGU-MHD'
APP = 'wali_datalog'

# One Store entry per head unit, built from the same app. `requires` names the infrastructure components the Store
# installs alongside: the GPU layer renderer (iDrive 8 draws through it), the controller input gate (iDrive 7), and
# mgu-deploy (iDrive 8 keeps the tile after the car syncs apps with BMW's backend). These mirror the versions the
# community apps on these head units depend on; adjust to the Store's current components if a newer set ships.
APPS = (
    (APP,        ['ID7'], {'mgu-render': '0.6.11', 'mgu-inputgate': '1.0.0'}),
    (APP + '8',  ['ID8'], {'mgu-render': '0.6.11', 'mgu-deploy': '0.7.16'}),
)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()


def strip_sdk(src, dst, mtime):
    """The OAP package again, without node_modules/oap-sdk, sorted, owner 0:0, one mtime (reproducible)."""
    with tarfile.open(src, 'r:gz') as t:
        members = [(m, t.extractfile(m).read() if m.isfile() else None) for m in t.getmembers()]
    keep = [(m, d) for m, d in members if 'node_modules/oap-sdk' not in m.name]
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=tarfile.USTAR_FORMAT) as out:
        for m, d in sorted(keep, key=lambda x: x[0].name):
            m.uid = m.gid = 0
            m.uname = m.gname = ''
            m.mtime = mtime
            out.addfile(m, io.BytesIO(d) if d is not None else None)
    with open(dst, 'wb') as f, gzip.GzipFile(fileobj=f, mode='wb', mtime=mtime, filename='') as g:
        g.write(buf.getvalue())
    with tarfile.open(dst, 'r:gz') as t:
        assert not any('oap-sdk' in n for n in t.getnames()), 'oap-sdk left in the package'


def artifact(path, base):
    name = os.path.basename(path)
    return {'name': name, 'size': os.path.getsize(path), 'sha256': sha256(path), 'url': base + name}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', default=REPO)
    ap.add_argument('--base', default=None)
    ap.add_argument('--hmi', choices=['ID7', 'ID8', 'both'], default='both')
    a = ap.parse_args()
    a.base = a.base or 'https://github.com/%s/releases/download/catalog/' % a.repo
    hmis = ['ID7', 'ID8'] if a.hmi == 'both' else [a.hmi]
    apps = [x for x in APPS if set(x[1]) <= set(hmis)]
    mtime = int(os.environ.get('SOURCE_DATE_EPOCH', '0'))
    out = os.path.join(ROOT, 'dist', 'release')
    shutil.rmtree(out, ignore_errors=True)
    os.makedirs(out)

    spec = json.load(open(os.path.join(ROOT, 'apps', APP, 'app.json')))
    ver = spec['version']
    pkgs = {}
    for aid, hmi, _ in apps:
        name = '%s@%s.tgz' % (aid, ver)
        if hmi == ['ID8']:
            # the source package, as build.py packed it; re-checked here (an OAP package installs on iDrive 8 and
            # never starts, so make sure this is the source kind: mgu-app.json, modules present, no app.js bundle)
            pkg = os.path.join(ROOT, 'dist', 'src', name)
            if not os.path.isfile(pkg):
                sys.exit('release.py: %s missing (python3 kit/tools/build.py --hmi ID8 %s)' % (pkg, APP))
            with tarfile.open(pkg, 'r:gz') as t:
                names = t.getnames()
                m = json.load(t.extractfile([n for n in names if n.endswith('mgu-app.json')][0]))
            if (m.get('id'), m.get('version')) != (aid, ver) \
                    or any('node_modules' in n or n.endswith('javascript/app.js') for n in names):
                sys.exit('release.py: %s is not the source package of %s %s' % (pkg, aid, ver))
            shutil.copy(pkg, os.path.join(out, name))
            pkgs[aid] = name
            continue
        pkg = os.path.join(ROOT, 'dist', name)
        if not os.path.isfile(pkg):
            sys.exit('release.py: %s missing (python3 kit/tools/build.py %s)' % (pkg, APP))
        strip_sdk(pkg, os.path.join(out, name), mtime)
        pkgs[aid] = name

    icon = APP + '.png'
    shutil.copy(os.path.join(ROOT, 'apps', APP, 'icon.png'), os.path.join(out, icon))
    assert os.path.getsize(os.path.join(out, icon)) <= 128 * 1024, 'icon too large'

    comps = []
    for aid, hmi, requires in apps:
        desc = spec['description'] if hmi == ['ID7'] else spec.get('id8', {}).get('description', spec['description'])
        c = {
            'id': aid, 'kind': 'app', 'title': spec['title'], 'description': desc, 'version': ver,
            'artifact': artifact(os.path.join(out, pkgs[aid]), a.base), 'requires': requires,
            'uninstallable': True, 'mguHmi': hmi, 'icon': icon, 'iconSha256': sha256(os.path.join(out, icon)),
        }
        if hmi == ['ID8']:
            c['build'] = 'unit'      # the Store: the artifact is a source package, built on the head unit
        comps.append(c)

    with open(os.path.join(out, 'catalog.json'), 'w') as f:
        json.dump({'schema': 2, 'components': comps}, f, indent=2)
        f.write('\n')
    for n in sorted(os.listdir(out)):
        print('%10d  %s' % (os.path.getsize(os.path.join(out, n)), n))


if __name__ == '__main__':
    main()
