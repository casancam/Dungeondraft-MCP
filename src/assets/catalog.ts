import fs from 'node:fs';
import path from 'node:path';
import { readPckIndex, readPckText } from './pck.js';
import type { PackManifestEntry } from '../map/types.js';

export const CATEGORIES = ['objects', 'paths', 'walls', 'portals', 'lights', 'terrain', 'tilesets', 'patterns', 'materials', 'caves', 'roofs'] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Asset {
  /** Exactly what goes in the map file, e.g. res://textures/objects/... or res://packs/<ID>/textures/... */
  path: string;
  category: Category;
  /** "builtin" or the pack id */
  source: string;
  name: string;
  tags: string[];
}

export interface PackInfo {
  id: string;
  name: string;
  author: string;
  version: string;
  file: string;
  /** Pack author opted out of third-party tools reading the pack: contents are not listed. */
  restricted: boolean;
  assetCount: number;
  manifest: PackManifestEntry;
}

export interface CatalogConfig {
  /** Dungeondraft install folder (contains Dungeondraft.pck). */
  installDir?: string;
  /** Folders containing *.dungeondraft_pack files (Dungeondraft's "Asset Folder"). */
  assetDirs: string[];
}

export interface CatalogStatus {
  builtinLoaded: boolean;
  builtinCount: number;
  builtinError?: string;
  packs: Omit<PackInfo, 'manifest'>[];
  packErrors: string[];
}

const IMAGE = /\.(png|webp|jpe?g)$/i;

function categorise(resPath: string): Category | null {
  const m = /^res:\/\/(?:packs\/[^/]+\/)?textures\/([^/]+)\//.exec(resPath);
  if (!m) return null;
  return (CATEGORIES as readonly string[]).includes(m[1]) ? (m[1] as Category) : null;
}

function nameOf(p: string): string {
  return path.posix.basename(p).replace(IMAGE, '');
}

function parseTags(text: string | null): Map<string, string[]> {
  const byAsset = new Map<string, string[]>();
  if (!text) return byAsset;
  try {
    const t = JSON.parse(text) as { tags?: Record<string, string[]> };
    for (const [tag, paths] of Object.entries(t.tags ?? {})) {
      for (const p of paths) {
        const list = byAsset.get(p) ?? [];
        list.push(tag);
        byAsset.set(p, list);
      }
    }
  } catch {
    /* tags are optional */
  }
  return byAsset;
}

export class AssetCatalog {
  private loaded = false;
  private assets: Asset[] = [];
  private byPath = new Map<string, Asset>();
  private packs = new Map<string, PackInfo>();
  private status: CatalogStatus = { builtinLoaded: false, builtinCount: 0, packs: [], packErrors: [] };

  constructor(private readonly config: CatalogConfig) {}

  load(force = false): CatalogStatus {
    if (this.loaded && !force) return this.status;
    this.assets = [];
    this.byPath.clear();
    this.packs.clear();
    this.status = { builtinLoaded: false, builtinCount: 0, packs: [], packErrors: [] };
    this.loadBuiltin();
    for (const dir of this.config.assetDirs) this.loadPackDir(dir);
    this.loaded = true;
    return this.status;
  }

  private add(a: Asset) {
    if (this.byPath.has(a.path)) return;
    this.byPath.set(a.path, a);
    this.assets.push(a);
  }

  private loadBuiltin() {
    const dir = this.config.installDir;
    if (!dir) {
      this.status.builtinError = 'Dungeondraft install folder not configured (DUNGEONDRAFT_DIR).';
      return;
    }
    const pck = path.join(dir, 'Dungeondraft.pck');
    const target = fs.existsSync(pck) ? pck : path.join(dir, 'Dungeondraft.exe');
    try {
      const idx = readPckIndex(target);
      const tags = parseTags(readPckText(idx, 'res://data/default.dungeondraft_tags'));
      for (const e of idx.entries) {
        // Built-in textures are stored as imported resources: "<path>.png.import".
        const p = e.path.replace(/\.import$/, '');
        if (!IMAGE.test(p)) continue;
        const category = categorise(p);
        if (!category || p.startsWith('res://packs/')) continue;
        this.add({ path: p, category, source: 'builtin', name: nameOf(p), tags: tags.get(p) ?? [] });
      }
      this.status.builtinLoaded = true;
      this.status.builtinCount = this.assets.length;
    } catch (e) {
      this.status.builtinError = `Could not read built-in assets from ${target}: ${(e as Error).message}`;
    }
  }

  private loadPackDir(dir: string) {
    let files: string[] = [];
    try {
      files = walk(dir, 2).filter((f) => f.toLowerCase().endsWith('.dungeondraft_pack'));
    } catch (e) {
      this.status.packErrors.push(`Cannot read asset folder ${dir}: ${(e as Error).message}`);
      return;
    }
    for (const file of files) {
      try {
        const idx = readPckIndex(file);
        const packJsonEntry = idx.entries.find((e) => /^res:\/\/packs\/[^/]+\/pack\.json$/.test(e.path));
        if (!packJsonEntry) throw new Error('no pack.json');
        const meta = JSON.parse(readPckText(idx, packJsonEntry.path) ?? '{}') as Record<string, unknown>;
        const id = String(meta.id ?? packJsonEntry.path.split('/')[3]);
        const restricted = meta.allow_3rd_party_mapping_software_to_read === false;
        const manifest: PackManifestEntry = {
          name: String(meta.name ?? id),
          id,
          version: String(meta.version ?? ''),
          author: String(meta.author ?? ''),
          ...(meta.keywords !== undefined ? { keywords: meta.keywords } : {}),
          ...(meta.allow_3rd_party_mapping_software_to_read !== undefined
            ? { allow_3rd_party_mapping_software_to_read: meta.allow_3rd_party_mapping_software_to_read as boolean }
            : {}),
          custom_color_overrides: meta.custom_color_overrides ?? { enabled: false, min_redness: 0.1, min_saturation: 0, red_tolerance: 0.04 },
        };
        let count = 0;
        if (!restricted) {
          const tags = parseTags(readPckText(idx, `res://packs/${id}/data/default.dungeondraft_tags`));
          for (const e of idx.entries) {
            if (!IMAGE.test(e.path) || e.path.includes('/thumbnails/')) continue;
            const category = categorise(e.path);
            if (!category) continue;
            this.add({ path: e.path, category, source: id, name: nameOf(e.path), tags: tags.get(e.path) ?? [] });
            count++;
          }
        }
        const info: PackInfo = { id, name: manifest.name, author: manifest.author, version: manifest.version, file, restricted, assetCount: count, manifest };
        this.packs.set(id, info);
        const { manifest: _m, ...pub } = info;
        this.status.packs.push(pub);
      } catch (e) {
        this.status.packErrors.push(`${path.basename(file)}: ${(e as Error).message}`);
      }
    }
  }

  search(opts: { query?: string; category?: Category; source?: string; tag?: string; offset?: number; limit?: number }) {
    this.load();
    const terms = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const tag = opts.tag?.toLowerCase();
    const hits = this.assets.filter((a) => {
      if (opts.category && a.category !== opts.category) return false;
      if (opts.source && a.source.toLowerCase() !== opts.source.toLowerCase()) return false;
      if (tag && !a.tags.some((t) => t.toLowerCase() === tag)) return false;
      if (opts.category === 'walls' && /_end\.(png|webp)$/i.test(a.path)) return false;
      const hay = `${a.path} ${a.tags.join(' ')}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return { total: hits.length, offset, items: hits.slice(offset, offset + limit), hasMore: offset + limit < hits.length };
  }

  summary() {
    this.load();
    const byCat: Record<string, number> = {};
    const tags = new Map<string, number>();
    for (const a of this.assets) {
      byCat[a.category] = (byCat[a.category] ?? 0) + 1;
      for (const t of a.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    }
    return { status: this.status, byCategory: byCat, tags: [...tags.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `${t} (${n})`) };
  }

  pack(id: string): PackInfo | undefined {
    this.load();
    return this.packs.get(id);
  }

  /**
   * Check a texture reference before writing it into a map. Returns an error message (reject),
   * or ok with an optional warning (accept but tell the user) and the pack it needs.
   */
  validate(texture: string, expected: Category | Category[]): { ok: true; warning?: string; pack?: PackInfo } | { ok: false; error: string } {
    this.load();
    const allowed = Array.isArray(expected) ? expected : [expected];
    const category = categorise(texture);
    if (!category) return { ok: false, error: `"${texture}" is not a Dungeondraft texture path (expected res://textures/<category>/... or res://packs/<ID>/textures/<category>/...). Use list-assets to find one.` };
    if (!allowed.includes(category)) return { ok: false, error: `"${texture}" is a ${category} asset; this needs ${allowed.join(' or ')}.` };

    const packMatch = /^res:\/\/packs\/([^/]+)\//.exec(texture);
    if (!packMatch) {
      if (!this.status.builtinLoaded) return { ok: true, warning: `Built-in assets not loaded (${this.status.builtinError ?? 'unknown'}); "${texture}" was not checked.` };
      if (!this.byPath.has(texture)) return { ok: false, error: `Built-in asset "${texture}" does not exist. Use list-assets to search.` };
      return { ok: true };
    }
    const pack = this.packs.get(packMatch[1]);
    if (!pack) return { ok: false, error: `Asset pack "${packMatch[1]}" is not installed in the configured asset folders (DD_ASSET_DIRS).` };
    if (pack.restricted) return { ok: true, pack, warning: `Pack "${pack.name}" does not allow third-party tools to list its contents, so "${texture}" was not checked. Double-check the path.` };
    if (!this.byPath.has(texture)) return { ok: false, error: `"${texture}" is not in pack "${pack.name}". Use list-assets with source "${pack.id}".` };
    return { ok: true, pack };
  }
}

function walk(dir: string, depth: number): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile()) out.push(p);
    else if (e.isDirectory() && depth > 0) out.push(...walk(p, depth - 1));
  }
  return out;
}
