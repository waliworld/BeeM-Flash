#!/usr/bin/env python3
# verify_mg1_checksum.py — our own re-implementation of the documented Bosch MG1
# block-CRC scheme, used to TEST whether it matches real BMW MG1CS stock images.
# Reads a .bin as data and reports each block's stored vs computed CRC. Writes
# nothing. (Algorithm documented by the MIT-licensed NetworkDir/moto-ecu-checksum;
# reimplemented here so we can confirm it on BMW automotive DMEs before relying on
# it.)
import sys, os, struct, zlib

SEED = 0x533F71C8          # zlib seed == effective init 0xACC08E37
STEP = 0x40000
FILL_LEN = 0x15C
HEAD = bytes.fromhex("DEADBEEF")
FILL = bytes.fromhex("12345678")
MSE8_FOOTER = bytes.fromhex("12341008")

def find_blocks(data):
    blocks, p = [], data.find(FILL)
    while p != -1:
        e = p
        while data[e:e + 4] == FILL:
            e += 4
        if e - p == FILL_LEN and e + 4 <= len(data) and data[e:e + 4] != MSE8_FOOTER:
            s = p // STEP * STEP
            while s >= 0 and data[s:s + 4] != HEAD:
                s -= STEP
            if s >= 0:
                blocks.append((s, e))
        p = data.find(FILL, max(e, p + 1))
    return blocks

def main():
    data = open(sys.argv[1], "rb").read()
    print("%s  (%d bytes)" % (os.path.basename(sys.argv[1]), len(data)))
    blocks = find_blocks(data)
    if not blocks:
        print("  NO MG1 block found"); return
    allok = True
    for s, e in blocks:
        computed = zlib.crc32(data[s:e], SEED) & 0xFFFFFFFF
        stored = struct.unpack_from(">I", data, e)[0]
        ok = computed == stored
        allok = allok and ok
        print("  block @0x%06X  crc @0x%06X  (len 0x%X)  stored=0x%08X computed=0x%08X  %s"
              % (s, e, e - s, stored, computed, "OK" if ok else "BAD"))
    print("  => scheme %s this image" % ("MATCHES" if allok else "does NOT match"))

if __name__ == "__main__":
    main()
