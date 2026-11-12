#!/usr/bin/env python3
# build_binfingerprints.py — SHA-256 fingerprint a tree of BMW MG1 DME bins.
#
# We store ONLY fingerprints (sha256 + size + the public calibration ID parsed
# from the filename) — never the bin bytes, which are BMW firmware. The
# fingerprints let BeeM-Flash verify a calibration is byte-for-byte a known STOCK
# image, or positively identify a known MHD+ custom-code base, which catches a
# map-only tune that keeps the stock calibration ID.
#
# Usage: python3 -I scripts/build_binfingerprints.py <bins_root> <out.json>
# Reads only.
import sys, os, re, hashlib, json

# directory name -> (engine label, DME ecu type)
ENGINE = {
    'b58gen1': ('B58gen1', 'MG1CS003'),
    'b58gen2': ('B58gen2', 'MG1CS201'),
    's58':     ('S58',     'MG1CS049'),
}
ID_RE = re.compile(r'^([0-9A-Fa-f]{10,16})')

def kind_of(fn):
    low = fn.lower()
    if 'mapswitchbase' in low:
        return 'mhdplus'     # MHD+ custom-code base = a tuned base
    if '_original' in low:
        return 'stock'
    return 'other'

def main():
    root, out = sys.argv[1], sys.argv[2]
    bins = []
    for dirpath, _d, files in os.walk(root):
        # which engine folder are we under?
        rel = os.path.relpath(dirpath, root).replace('\\', '/').lower()
        top = rel.split('/')[0]
        if top not in ENGINE:
            continue
        engine, ecu = ENGINE[top]
        for fn in files:
            if not fn.lower().endswith('.bin'):
                continue
            k = kind_of(fn)
            if k == 'other':
                continue
            m = ID_RE.match(fn)
            if not m:
                continue
            cid = m.group(1).upper()
            path = os.path.join(dirpath, fn)
            h = hashlib.sha256()
            size = 0
            with open(path, 'rb') as fh:
                while True:
                    b = fh.read(1 << 20)
                    if not b:
                        break
                    size += len(b)
                    h.update(b)
            variant = 'b58o1' if 'b58o1' in fn.lower() else ''
            bins.append({'id': cid, 'engine': engine, 'ecu': ecu, 'kind': k,
                         'variant': variant, 'size': size, 'sha256': h.hexdigest()})
    bins.sort(key=lambda x: (x['engine'], x['id'], x['kind'], x['variant']))
    db = {
        'source': 'dmacpro91/BMW-XDFs (community stock + MHD+ base bins). Fingerprints only; bins are BMW firmware and are NOT redistributed.',
        'note': 'sha256 of full DME images. kind=stock is an unmodified stock image; kind=mhdplus is an MHD+ custom-code base (a tuned base). A calibration whose bytes match a stock fingerprint is byte-for-byte stock; a match to an mhdplus fingerprint is a known MHD+ base. No match on a known calibration ID means modified/unknown.',
        'bins': bins,
    }
    with open(out, 'w', encoding='utf-8') as fh:
        json.dump(db, fh, indent=1); fh.write('\n')
    ns = sum(1 for b in bins if b['kind'] == 'stock'); nm = sum(1 for b in bins if b['kind'] == 'mhdplus')
    print('fingerprinted %d bins (%d stock, %d MHD+) -> %s' % (len(bins), ns, nm, out))
    from collections import Counter
    for eng, c in sorted(Counter(b['engine'] for b in bins).items()):
        print('  %-9s %d' % (eng, c))

if __name__ == '__main__':
    main()
