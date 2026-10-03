import fs from 'node:fs';
import path from 'node:path';
import { parseGodotJson, printGodotJson, type JsonObject, type JsonValue } from '../godot/json.js';
import type { DDMap, Level } from './types.js';

export const MAP_EXT = '.dungeondraft_map';

export interface LoadedMap {
  path: string;
  /** Exact bytes read from disk, used to detect concurrent modification before writing. */
  originalText: string;
  map: DDMap;
}

export function loadMap(file: string): LoadedMap {
  if (!file.toLowerCase().endsWith(MAP_EXT)) throw new Error(`Not a Dungeondraft map (expected *${MAP_EXT}): ${file}`);
  const text = fs.readFileSync(file, 'utf8');
  const map = parseMapText(text, file);
  return { path: file, originalText: text, map };
}

export function parseMapText(text: string, label = 'map'): DDMap {
  const v = parseGodotJson(text) as JsonObject;
  const world = v?.world as JsonObject | undefined;
  if (!v || typeof v !== 'object' || !v.header || !world || typeof world.levels !== 'object' || world.levels === null) {
    throw new Error(`${label} does not look like a Dungeondraft map (missing header/world/levels).`);
  }
  return v as unknown as DDMap;
}

/**
 * Splits a map into independently comparable sections. After an edit, every section the edit did
 * not declare as touched must serialise to exactly the same text as before.
 */
export function sectionFingerprints(map: DDMap): Map<string, string> {
  const out = new Map<string, string>();
  const root = map as unknown as JsonObject;
  for (const [k, v] of Object.entries(root)) {
    if (k === 'world' || k === 'header') continue;
    out.set(k, printGodotJson(v, { trailingNewline: false }));
  }
  for (const [k, v] of Object.entries(map.header as unknown as JsonObject)) out.set(`header.${k}`, printGodotJson(v, { trailingNewline: false }));
  for (const [k, v] of Object.entries(map.world as unknown as JsonObject)) {
    if (k === 'levels') continue;
    out.set(`world.${k}`, printGodotJson(v, { trailingNewline: false }));
  }
  for (const [lk, level] of Object.entries(map.world.levels)) {
    for (const [k, v] of Object.entries(level as unknown as JsonObject)) out.set(`level.${lk}.${k}`, printGodotJson(v as JsonValue, { trailingNewline: false }));
  }
  return out;
}

export interface SaveOptions {
  /** Sections the edit was allowed to change (keys from sectionFingerprints). */
  touched: Set<string>;
  /** Fingerprints of the map as loaded. */
  before: Map<string, string>;
  /** Extra checks on the re-parsed result; throw to abort. */
  verify?: (reparsed: DDMap) => void;
  /** Override the timestamp used in the backup name (tests). */
  now?: Date;
}

export interface SaveResult {
  path: string;
  backup: string | null;
  bytes: number;
  changedSections: string[];
}

/** `<file>.bak-YYYYMMDD-HHMMSS` (UTC), with `-2`, `-3`... if several saves land in the same second. */
export function backupName(file: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  let name = `${file}.bak-${ts}`;
  for (let n = 2; fs.existsSync(name); n++) name = `${file}.bak-${ts}-${n}`;
  return name;
}

/**
 * Safe write: refuse if the file changed since it was read, back it up, write to a temp file,
 * re-parse and verify the temp file, then atomically rename over the original.
 */
export function saveMap(loaded: LoadedMap, opts: SaveOptions): SaveResult {
  const text = printGodotJson(loaded.map as unknown as JsonValue);
  const reparsed = parseMapText(text, 'serialised map');

  if (printGodotJson(reparsed as unknown as JsonValue) !== text) throw new Error('Round-trip check failed: re-serialising the new map gives different output. Nothing was written.');
  const after = sectionFingerprints(reparsed);
  const changed: string[] = [];
  for (const k of new Set([...opts.before.keys(), ...after.keys()])) {
    if (opts.before.get(k) === after.get(k)) continue;
    if (!opts.touched.has(k)) throw new Error(`Safety check failed: section "${k}" changed but the edit did not declare it. Nothing was written.`);
    changed.push(k);
  }
  opts.verify?.(reparsed);

  const exists = fs.existsSync(loaded.path);
  if (exists) {
    const onDisk = fs.readFileSync(loaded.path, 'utf8');
    if (onDisk !== loaded.originalText) throw new Error(`${path.basename(loaded.path)} changed on disk since it was read (saved from Dungeondraft?). Nothing was written; retry the edit.`);
  }

  let backup: string | null = null;
  if (exists) {
    backup = backupName(loaded.path, opts.now);
    fs.copyFileSync(loaded.path, backup, fs.constants.COPYFILE_EXCL);
  }

  const tmp = `${loaded.path}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    const back = fs.readFileSync(tmp, 'utf8');
    if (back !== text) throw new Error('Temp file content differs from what was written.');
    const check = parseMapText(back, 'written map');
    if (printGodotJson(check as unknown as JsonValue) !== text) throw new Error('Written file does not round-trip.');
    fs.renameSync(tmp, loaded.path);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Write aborted, original left untouched${backup ? ` (backup at ${backup})` : ''}: ${(e as Error).message}`);
  }

  loaded.originalText = text;
  return { path: loaded.path, backup, bytes: Buffer.byteLength(text), changedSections: changed };
}

export function levelEntries(map: DDMap): [string, Level][] {
  return Object.entries(map.world.levels);
}
