import { countElements } from './editor.js';
import type { DDMap, Level } from './types.js';

function textures(level: Level): string[] {
  const out: string[] = [];
  for (const k of ['objects', 'paths', 'patterns', 'lights', 'walls'] as const) for (const el of (level[k] ?? []) as { texture: string }[]) out.push(el.texture);
  for (const w of level.walls ?? []) for (const p of w.portals ?? []) out.push(p.texture);
  for (const p of level.portals ?? []) out.push(p.texture);
  return out;
}

/** Compact summary; never returns raw map data. */
export function summariseMap(map: DDMap, opts: { topAssets?: number } = {}) {
  const world = map.world;
  const top = opts.topAssets ?? 15;
  const levels = Object.entries(world.levels).map(([key, l]) => {
    const t = l.terrain;
    const slots = [1, 2, 3, 4, 5, 6, 7, 8]
      .filter((s) => t?.[`texture_${s}`] && (s <= 4 || t.expand_slots))
      .map((s) => `${s}: ${String(t[`texture_${s}`]).replace(/^res:\/\/(packs\/[^/]+\/)?textures\/terrain\//, '')}`);
    const used = new Map<string, number>();
    for (const tex of textures(l)) used.set(tex, (used.get(tex) ?? 0) + 1);
    return {
      key,
      label: l.label,
      counts: countElements(l),
      terrain: t ? { enabled: t.enabled, slots } : null,
      environment: l.environment,
      water: Boolean((l.water as { tree?: { children?: unknown[] } })?.tree?.children?.length),
      layers: l.layers,
      topAssets: [...used.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([p, n]) => `${n}x ${p}`),
      distinctAssets: used.size,
    };
  });
  return {
    build: map.header.creation_build,
    format: world.format,
    size: { width: world.width, height: world.height, units: 'grid squares (256 Dungeondraft px each)' },
    usesDefaultAssets: map.header.uses_default_assets,
    assetPacks: (map.header.asset_manifest ?? []).map((m) => `${m.name} (${m.id}) by ${m.author}`),
    currentLevel: map.header.editor_state?.current_level,
    levels,
  };
}
