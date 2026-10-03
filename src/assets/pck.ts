import fs from 'node:fs';

/**
 * Minimal reader for Godot 3 PCK archives (Dungeondraft.pck and *.dungeondraft_pack).
 * Layout (little-endian): u32 magic "GDPC", u32 pack version, u32 godot major/minor/patch,
 * 16 x u32 reserved, u32 file count, then per file: u32 path length, path bytes (NUL padded),
 * u64 offset, u64 size, 16-byte md5. Files are stored uncompressed.
 * Only the index and small text files are ever read; image data is never touched.
 */

const MAGIC = 0x43504447; // "GDPC"

export interface PckEntry {
  path: string;
  offset: number;
  size: number;
}

export interface PckIndex {
  file: string;
  godotVersion: string;
  entries: PckEntry[];
}

export function readPckIndex(file: string): PckIndex {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let base = 0;
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    if (head.readUInt32LE(0) !== MAGIC) {
      // Self-contained exe: the pack is appended, and the last 12 bytes are u64 pack offset + magic.
      const tail = Buffer.alloc(12);
      fs.readSync(fd, tail, 0, 12, size - 12);
      if (tail.readUInt32LE(8) !== MAGIC) throw new Error(`${file} is not a Godot PCK archive.`);
      base = size - 12 - Number(tail.readBigUInt64LE(0));
    }

    let pos = base;
    const read = (n: number): Buffer => {
      const b = Buffer.alloc(n);
      const got = fs.readSync(fd, b, 0, n, pos);
      if (got !== n) throw new Error(`Truncated PCK index in ${file}`);
      pos += n;
      return b;
    };
    const h = read(4 + 4 + 12 + 64 + 4);
    if (h.readUInt32LE(0) !== MAGIC) throw new Error(`${file}: bad PCK magic.`);
    const packVersion = h.readUInt32LE(4);
    if (packVersion > 1) throw new Error(`${file}: PCK format ${packVersion} not supported (Godot 4?).`);
    const godotVersion = `${h.readUInt32LE(8)}.${h.readUInt32LE(12)}.${h.readUInt32LE(16)}`;
    const count = h.readUInt32LE(84);
    if (count > 1_000_000) throw new Error(`${file}: implausible file count ${count}.`);

    const entries: PckEntry[] = [];
    for (let i = 0; i < count; i++) {
      const len = read(4).readUInt32LE(0);
      const p = read(len).toString('utf8').replace(/\0+$/, '');
      const meta = read(8 + 8 + 16);
      entries.push({ path: p, offset: base + Number(meta.readBigUInt64LE(0)), size: Number(meta.readBigUInt64LE(8)) });
    }
    return { file, godotVersion, entries };
  } finally {
    fs.closeSync(fd);
  }
}

/** Read one small text file (e.g. pack.json, tags) out of a PCK. */
export function readPckText(index: PckIndex, resPath: string, maxBytes = 8 * 1024 * 1024): string | null {
  const e = index.entries.find((x) => x.path === resPath);
  if (!e) return null;
  if (e.size > maxBytes) throw new Error(`${resPath} in ${index.file} is too large to read (${e.size} bytes).`);
  const fd = fs.openSync(index.file, 'r');
  try {
    const b = Buffer.alloc(e.size);
    fs.readSync(fd, b, 0, e.size, e.offset);
    return b.toString('utf8').replace(/^﻿/, '');
  } finally {
    fs.closeSync(fd);
  }
}
