#!/usr/bin/env python3
# build_stockdb.py — extract the set of STOCK DME calibration identifiers from a
# directory of BMW MG1 A2L files (e.g. the mgflasher-team/mgflasher-map-packs
# A2Ls, Apache-2.0). Each A2L carries the ECU type, the stock VERSION string and
# the EPK identifier; collecting them across all files gives the full set of
# stock calibration IDs, which BeeM-Flash compares the car's reported ID against
# to decide stock-vs-modified definitively.
#
# Usage: python3 -I scripts/build_stockdb.py <A2Ls_dir> <out.json>
# Reads only; writes a compact JSON database.
import sys, os, re, json

ENGINE_BY_ECU = {
    'MG1CS003': 'B58/B48 Gen1',
    'MG1CS201': 'B58/B48 Gen2',
    'MG1CS049': 'S58',
    'MG1CS024': 'S58 (early / M3-M4 comp)',
    'MG1CS002': 'N63/S63',
    'MG1CS008': 'N63/S63',
}

ecu_re = re.compile(r'ECU\s+"([^"]+)"')
ver_re = re.compile(r'VERSION\s+"([^"]+)"')
epk_re = re.compile(r'EPK\s+"([^"]+)"')
fname_re = re.compile(r'^([A-Za-z0-9]+)_([0-9a-fA-F]{3,5})-')

def main():
    root, out = sys.argv[1], sys.argv[2]
    db = {}       # ecu -> { engine, bases:set, versions:set, fileTokens:set }
    nfiles = 0
    for dirpath, _dirs, files in os.walk(root):
        for fn in files:
            if not fn.lower().endswith('.a2l'):
                continue
            nfiles += 1
            path = os.path.join(dirpath, fn)
            ecu = ver = epk = None
            try:
                with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
                    # the identifiers are all within the MOD_PAR header near the top
                    head = fh.read(8000)
            except Exception:
                continue
            m = ecu_re.search(head); ecu = m.group(1) if m else None
            m = ver_re.search(head); ver = m.group(1) if m else None
            m = epk_re.search(head); epk = m.group(1) if m else None
            if not ecu:
                continue
            e = db.setdefault(ecu, {'engine': ENGINE_BY_ECU.get(ecu, 'unknown'),
                                    'bases': set(), 'versions': set(), 'fileTokens': set()})
            fm = fname_re.match(fn)
            if fm:
                e['fileTokens'].add(fm.group(1))
                e['bases'].add(fm.group(2).lower())
            if ver:
                e['versions'].add(ver)
            # the EPK repeats the version; capture the base from it too (…_<engine>_<VER>…)
            if epk:
                for tok in re.split(r'[/_]', epk):
                    if re.fullmatch(r'[0-9a-fA-F]{4}', tok) and tok.lower() != ecu.lower():
                        pass  # bases already from filename; keep EPK out of noise

    outdb = {
        'source': 'mgflasher-team/mgflasher-map-packs A2Ls (Apache-2.0)',
        'note': 'Stock DME calibration identifiers. A car reporting one of these versions is running a recognised STOCK calibration. A known ECU type reporting a version NOT in this set is not a known stock calibration (tuned, or newer SW than this dataset).',
        'ecus': {}
    }
    for ecu in sorted(db):
        e = db[ecu]
        outdb['ecus'][ecu] = {
            'engine': e['engine'],
            'bases': sorted(e['bases']),
            'versions': sorted(e['versions']),
            'fileTokens': sorted(e['fileTokens']),
        }
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(outdb, fh, indent=1)
        fh.write('\n')
    tot = sum(len(v['versions']) for v in outdb['ecus'].values())
    print('scanned %d A2Ls; %d ECU types; %d stock versions -> %s' % (nfiles, len(outdb['ecus']), tot, out))
    for ecu in sorted(outdb['ecus']):
        v = outdb['ecus'][ecu]
        print('  %-10s %-24s bases=%s versions=%d' % (ecu, v['engine'], ','.join(v['bases']), len(v['versions'])))

if __name__ == '__main__':
    main()
