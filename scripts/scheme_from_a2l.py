#!/usr/bin/env python3
# scheme_from_a2l.py — build a checksum-scheme TEMPLATE from a BMW MG1 A2L.
#
# The A2L's MEMORY_SEGMENTs that carry an XCP_CRC_32 CHECKSUM are the code/
# calibration areas the standard CRC-32 covers. This emits a checksum scheme with
# those ranges filled and the STORE location left as a TODO — because the A2L
# does not say where the bootloader's stored CRC lives (that comes from the bin /
# WinOLS). It is a safe starting point, never an auto-applied default.
#
# Usage: python3 -I scripts/scheme_from_a2l.py <file.a2l> <out.json>
import sys, re, json, os

def main():
    text = open(sys.argv[1], 'r', encoding='utf-8', errors='ignore').read()
    ecu = (re.search(r'ECU\s+"([^"]+)"', text) or [None, '?'])[1]
    ver = (re.search(r'VERSION\s+"([^"]+)"', text) or [None, '?'])[1]
    segs = []
    # each MEMORY_SEGMENT: name line, then "<PRG> <MEM> <ATTR> 0xADDR 0xSIZE ..."
    for m in re.finditer(r'/begin\s+MEMORY_SEGMENT\s+(\S+)(.*?)/end\s+MEMORY_SEGMENT', text, re.S):
        name, body = m.group(1), m.group(2)
        dm = re.search(r'\b(CODE|DATA)\s+FLASH\s+\w+\s+(0x[0-9A-Fa-f]+)\s+(0x[0-9A-Fa-f]+)', body)
        has_crc = 'XCP_CRC_32' in body
        if dm and has_crc:
            addr, size = int(dm.group(2), 16), int(dm.group(3), 16)
            segs.append({'name': name, 'start': addr, 'size': size, 'end': addr + size})
    blocks = []
    for s in segs:
        blocks.append({
            'name': s['name'], 'algo': 'crc32',
            'ranges': [[s['start'], s['end']]],
            'store': {'at': '__TODO_fill_from_bin_or_WinOLS__', 'size': 4, 'endian': 'le'},
            'params': {'__note': 'XCP_CRC_32 = IEEE CRC-32; confirm init/seed and the big/little-endian store on your DME before use'}
        })
    out = {
        'source': 'template generated from A2L ' + os.path.basename(sys.argv[1]),
        'ecu': ecu, 'version': ver,
        'algorithm': 'XCP_CRC_32 (standard CRC-32) — from the A2L MEMORY_SEGMENT CHECKSUM blocks',
        'WARNING': 'UNVERIFIED TEMPLATE. The ranges are the A2L code segments; the STORE location and the exact CRC init/seed are NOT in the A2L and must be confirmed from the bin / WinOLS. MG1 also carries an RSA SIGNATURE a correct CRC does not satisfy. Do NOT flash using this template unverified.',
        'checksum': {'blocks': blocks}
    }
    json.dump(out, open(sys.argv[2], 'w'), indent=1)
    open(sys.argv[2], 'a').write('\n')
    print('%s %s: %d code segment(s) with XCP_CRC_32 -> %s' % (ecu, ver, len(blocks), sys.argv[2]))
    for b in blocks:
        print('  %-14s 0x%08X .. 0x%08X  (0x%X bytes)' % (b['name'], b['ranges'][0][0], b['ranges'][0][1], b['ranges'][0][1] - b['ranges'][0][0]))

if __name__ == '__main__':
    main()
