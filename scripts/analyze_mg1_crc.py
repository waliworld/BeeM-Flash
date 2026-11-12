#!/usr/bin/env python3
# analyze_mg1_crc.py — locate the stored CRC(s) of a BMW MG1CS DME image by
# computing candidate CRC-32s over the A2L flash segments and searching the bin
# for where that value is stored. Reads a .bin as data; writes nothing.
#
# file offset = flash address - BASE (confirmed: EPK sits at ADDR_EPK).
import sys, zlib, struct, binascii

BASE = 0x80000000
# MG1CS201 / MG1CS049 flash segments carrying XCP_CRC_32 (addr, size) from the A2L
SEGS = [
    ("code1", 0x80080000, 0x67F7E0),
    ("code2", 0x80028000, 0x37D00),
    ("data",  0x80700000, 0xFF7E0),
]

def u32le(b, o): return struct.unpack_from("<I", b, o)[0]
def u32be(b, o): return struct.unpack_from(">I", b, o)[0]

def all_offsets(data, val):
    hits = []
    for packed in (struct.pack("<I", val), struct.pack(">I", val)):
        i = data.find(packed)
        while i != -1:
            hits.append((i, "LE" if packed == struct.pack("<I", val) else "BE"))
            i = data.find(packed, i + 1)
    return hits

def crc_variants(block):
    """A spread of reflected CRC-32 variants (standard + common seeds)."""
    out = {}
    std = zlib.crc32(block) & 0xFFFFFFFF            # init FFFFFFFF, xorout FFFFFFFF (IEEE/zlib)
    out["crc32"] = std
    out["crc32~"] = (~std) & 0xFFFFFFFF            # == init FFFFFFFF, xorout 0
    out["crc32_init0"] = zlib.crc32(block, 0) & 0xFFFFFFFF  # seed 0
    out["crc32_initACC"] = zlib.crc32(block, 0x533F71C8) & 0xFFFFFFFF  # MG1-moto seed
    out["crc32_bswap"] = struct.unpack("<I", struct.pack(">I", std))[0]
    return out

def main():
    path = sys.argv[1]
    data = open(path, "rb").read()
    print("%s (%d bytes)" % (path.split("/")[-1], len(data)))
    for name, addr, size in SEGS:
        s = addr - BASE
        print("\n[%s] 0x%08X..0x%08X (file 0x%X..0x%X)" % (name, addr, addr + size, s, s + size))
        # try the full segment and the segment minus a trailing 4-byte CRC word
        for rlabel, e in (("full", s + size), ("minus4", s + size - 4)):
            block = data[s:e]
            for vname, val in crc_variants(block).items():
                hits = all_offsets(data, val)
                # highlight hits near the segment end or in the header tail (0x7FFxxx)
                near = [h for h in hits if (e - 8 <= h[0] <= e + 8) or (h[0] >= 0x7FF000)]
                if near:
                    for off, endian in near:
                        print("  MATCH range=%-6s %-14s=0x%08X  stored @file 0x%06X (addr 0x%08X) %s  [%d total hits]"
                              % (rlabel, vname, val, off, BASE + off, endian, len(hits)))

    # also dump the header tail region bytes (the small checksum/header segments)
    print("\n[header tail] 0x807FFC00..0x80800000:")
    for off in range(0x7FFC00, 0x800000, 16):
        row = data[off:off + 16]
        if any(b != 0xFF and b != 0x00 for b in row):
            print("  0x%06X: %s" % (off, binascii.hexlify(row).decode()))

if __name__ == "__main__":
    main()
