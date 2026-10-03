import type { AssetCatalog, Category } from '../assets/catalog.js';
import { loadMap, saveMap, sectionFingerprints, type LoadedMap, type SaveResult } from './mapfile.js';
import type { DDMap, Level } from './types.js';

export type ElementType = 'objects' | 'walls' | 'doors' | 'lights' | 'paths' | 'patterns' | 'texts';
export const ELEMENT_TYPES: ElementType[] = ['objects', 'walls', 'doors', 'lights', 'paths', 'patterns', 'texts'];

export function countElements(level: Level): Record<ElementType, number> {
  return {
    objects: level.objects?.length ?? 0,
    walls: level.walls?.length ?? 0,
    doors: (level.walls ?? []).reduce((n, w) => n + (w.portals?.length ?? 0), 0) + (level.portals?.length ?? 0),
    lights: level.lights?.length ?? 0,
    paths: level.paths?.length ?? 0,
    patterns: level.patterns?.length ?? 0,
    texts: level.texts?.length ?? 0,
  };
}

/**
 * One edit = load, mutate in memory, then commit through the safe writer. Tracks which sections
 * were touched and how element counts should change, so the save can be verified.
 */
export class MapEditor {
  readonly loaded: LoadedMap;
  readonly map: DDMap;
  private readonly before: Map<string, string>;
  private readonly touched = new Set<string>();
  private readonly countsBefore = new Map<string, Record<ElementType, number>>();
  private readonly deltas = new Map<string, Partial<Record<ElementType, number>>>();
  readonly warnings: string[] = [];

  constructor(file: string, readonly catalog: AssetCatalog) {
    this.loaded = loadMap(file);
    this.map = this.loaded.map;
    this.before = sectionFingerprints(this.map);
    for (const [k, l] of Object.entries(this.map.world.levels)) this.countsBefore.set(k, countElements(l));
  }

  get format(): number {
    return Number(this.map.world.format);
  }

  /** Level by key ("0"), index (0) or label ("Ground"). Defaults to the first level. */
  level(ref?: string | number): [string, Level] {
    const levels = Object.entries(this.map.world.levels);
    if (ref === undefined || ref === '') return levels[0];
    const s = String(ref);
    const hit = levels.find(([k]) => k === s) ?? levels.find(([, l]) => l.label?.toLowerCase() === s.toLowerCase());
    if (!hit) throw new Error(`Level ${JSON.stringify(ref)} not found. Levels: ${levels.map(([k, l]) => `${k} "${l.label}"`).join(', ')}`);
    return hit;
  }

  touch(levelKey: string | null, section: string) {
    this.touched.add(levelKey === null ? section : `level.${levelKey}.${section}`);
  }

  delta(levelKey: string, type: ElementType, n: number) {
    const d = this.deltas.get(levelKey) ?? {};
    d[type] = (d[type] ?? 0) + n;
    this.deltas.set(levelKey, d);
  }

  /** Allocate a node id from world.next_node_id (hex), as Dungeondraft does. */
  allocId(): string {
    const cur = parseInt(String(this.map.world.next_node_id), 16);
    if (!Number.isFinite(cur)) throw new Error(`world.next_node_id is not hex: ${this.map.world.next_node_id}`);
    this.map.world.next_node_id = (cur + 1).toString(16);
    this.touch(null, 'world.next_node_id');
    return cur.toString(16);
  }

  /** Validate a texture and make sure its pack is in the map's asset manifest. */
  useAsset(texture: string, category: Category | Category[]): void {
    const r = this.catalog.validate(texture, category);
    if (!r.ok) throw new Error(r.error);
    if (r.warning && !this.warnings.includes(r.warning)) this.warnings.push(r.warning);
    if (r.pack) {
      const manifest = this.map.header.asset_manifest;
      if (!manifest.some((m) => m.id === r.pack!.id)) {
        manifest.push(r.pack.manifest);
        this.touch(null, 'header.asset_manifest');
        this.warnings.push(`Added asset pack "${r.pack.name}" (${r.pack.id}) to the map's asset manifest.`);
      }
    }
  }

  /** Validate and write. With dryRun nothing touches the disk. */
  commit(dryRun: boolean): { saved: SaveResult | null; counts: Record<string, Record<ElementType, number>> } {
    const counts: Record<string, Record<ElementType, number>> = {};
    for (const [k, l] of Object.entries(this.map.world.levels)) counts[k] = countElements(l);
    // Expected counts = before + declared deltas; catches an operation that silently dropped data.
    const expect = (reparsed: DDMap) => {
      for (const [k, before] of this.countsBefore) {
        const lvl = reparsed.world.levels[k];
        if (!lvl) throw new Error(`Level ${k} missing after save.`);
        const after = countElements(lvl);
        const d = this.deltas.get(k) ?? {};
        for (const t of ELEMENT_TYPES) {
          const want = before[t] + (d[t] ?? 0);
          if (after[t] !== want) throw new Error(`Verification failed on level ${k}: expected ${want} ${t}, found ${after[t]}. Nothing was written.`);
        }
      }
    };
    if (dryRun) {
      expect(this.map);
      return { saved: null, counts };
    }
    const saved = saveMap(this.loaded, { touched: this.touched, before: this.before, verify: expect });
    return { saved, counts };
  }
}
