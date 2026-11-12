#!/usr/bin/env python3
# recover_mg1_crc.py — recover the exact CRC-32 parameters + covered range of the
# BMW MG1CS header checksum words, by trying the standard CRC-32 variants over a
# spread of candidate ranges and matching the stored word. Reads a .bin as data.
import sys, zlib, struct

BASE = 0x80000000

# reflected (zlib/IEEE) and forward (MPEG/BZIP2) CRC-32 tables
def mk_refl(poly=0xEDB88320):
    t = []
    for n in range(256):
        c = n
        for _ in range(8):
            c = (poly ^ (c >> 1)) if (c & 1) else (c >> 1)
        t.append(c & 0xFFFFFFFF)
    return t
def mk_fwd(poly=0x04C11DB7):
    t = []
    for n in range(256):
        c = (n << 24) & 0xFFFFFFFF
        for _ in range(8):
            c = ((c << 1) ^ poly) & 0xFFFFFFFF if (c & 0x80000000) else (c << 1) & 0xFFFFFFFF
        t.append(c)
    return t
RT, FT = mk_refl(), mk_fwd()
def crc_refl(data, init, xorout):
    c = init
    for b in data:
        c = (RT[(c ^ b) & 0xFF] ^ (c >> 8)) & 0xFFFFFFFF
    return (c ^ xorout) & 0xFFFFFFFF
def crc_fwd(data, init, xorout):
    c = init
    for b in data:
        c = (FT[((c >> 24) ^ b) & 0xFF] ^ (c << 8)) & 0xFFFFFFFF
    return (c ^ xorout) & 0xFFFFFFFF

CONFIGS = []
for name, fn in (("refl", crc_refl), ("fwd", crc_fwd)):
    for init in (0x00000000, 0xFFFFFFFF):
        for xorout in (0x00000000, 0xFFFFFFFF):
            CONFIGS.append(("%s i=%08X x=%08X" % (name, init, xorout), fn, init, xorout))

def try_target(data, store_off, starts):
    stored_le = struct.unpack_from("<I", data, store_off)[0]
    stored_be = struct.unpack_from(">I", data, store_off)[0]
    print("  stored @0x%06X  LE=0x%08X BE=0x%08X" % (store_off, stored_le, stored_be))
    for s in starts:
        block = data[s:store_off]
        for cname, fn, init, xo in CONFIGS:
            v = fn(block, init, xo)
            if v == stored_le:
                print("    HIT  range 0x%06X..0x%06X  %s  -> LE match" % (s, store_off, cname)); return True
            if v == stored_be:
                print("    HIT  range 0x%06X..0x%06X  %s  -> BE match" % (s, store_off, cname)); return True
    return False

def main():
    data = open(sys.argv[1], "rb").read()
    print(sys.argv[1].split("/")[-1])
    # header CRC @0x7FFFDC (end of the Dst807FFE0C id segment)
    print("[header id CRC @0x7FFFDC]")
    ok1 = try_target(data, 0x7FFFDC, [0x7FFE0C, 0x7FFE00, 0x7FFD08, 0x7FFD00, 0x7FFCFC, 0x7FFCF8, 0x7FFC00, 0x7FFFD0])
    # CRC word just after the 12345678 fill @0x7FFCF8
    print("[fill CRC @0x7FFCF8]")
    ok2 = try_target(data, 0x7FFCF8, [0x700000, 0x7FF7E0, 0x7FFC00, 0x7F0000, 0x000000, 0x80000, 0x28000])
    if not (ok1 or ok2):
        print("  no standard-CRC match on the tried ranges; the covered range or algo differs")

if __name__ == "__main__":
    main()
