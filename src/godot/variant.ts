/**
 * Codec for the Godot `var2str` strings Dungeondraft stores inside its JSON:
 *   "Vector2( 7040, 5120 )"
 *   "PoolVector2Array( x1, y1, x2, y2 )"   (empty: "PoolVector2Array(  )")
 *   "PoolIntArray( -1, 0, 3 )", "PoolByteArray( 255, 0, 0, 0 )"
 */

export type Vec2 = [number, number];

function body(s: string, type: string): string {
  const prefix = `${type}(`;
  const t = s.trim();
  if (!t.startsWith(prefix) || !t.endsWith(')')) throw new Error(`Expected ${type}(...), got ${JSON.stringify(s.slice(0, 60))}`);
  return t.slice(prefix.length, -1);
}

function numbers(b: string): number[] {
  const parts = b.split(',');
  const out: number[] = [];
  for (const p of parts) {
    const x = p.trim();
    if (!x) continue;
    const v = Number(x);
    if (!Number.isFinite(v)) throw new Error(`Bad number ${JSON.stringify(x)} in Godot array`);
    out.push(v);
  }
  return out;
}

/** Godot prints reals with ~6 significant digits (`4042.05`, `-1.570796`). */
export function formatReal(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`Cannot store non-finite number ${n}`);
  if (Number.isInteger(n)) return String(n);
  const abs = Math.abs(n);
  // Keep up to 6 decimals for small values (rotations), 6 significant digits otherwise.
  const s = abs >= 1 ? String(Number(n.toPrecision(Math.max(6, Math.ceil(Math.log10(abs + 1)))))) : String(Number(n.toFixed(6)));
  return s.includes('e') ? n.toFixed(6).replace(/\.?0+$/, '') : s;
}

export function parseVector2(s: string): Vec2 {
  const v = numbers(body(s, 'Vector2'));
  if (v.length !== 2) throw new Error(`Vector2 needs 2 numbers: ${s}`);
  return [v[0], v[1]];
}

export function formatVector2([x, y]: Vec2): string {
  return `Vector2( ${formatReal(x)}, ${formatReal(y)} )`;
}

export function parseVector2Array(s: string): Vec2[] {
  const v = numbers(body(s, 'PoolVector2Array'));
  if (v.length % 2) throw new Error('PoolVector2Array has an odd number of values');
  const out: Vec2[] = [];
  for (let i = 0; i < v.length; i += 2) out.push([v[i], v[i + 1]]);
  return out;
}

export function formatVector2Array(points: Vec2[]): string {
  if (!points.length) return 'PoolVector2Array(  )';
  return `PoolVector2Array( ${points.map(([x, y]) => `${formatReal(x)}, ${formatReal(y)}`).join(', ')} )`;
}

export function parseIntArray(s: string): number[] {
  return numbers(body(s, 'PoolIntArray'));
}

export function formatIntArray(v: ArrayLike<number>): string {
  return v.length ? `PoolIntArray( ${Array.from(v).join(', ')} )` : 'PoolIntArray(  )';
}

export function parseByteArray(s: string): Uint8Array {
  const b = body(s, 'PoolByteArray');
  const out = new Uint8Array(b.length / 2 + 1); // upper bound; trimmed below
  let n = 0;
  let cur = -1;
  for (let i = 0; i < b.length; i++) {
    const c = b.charCodeAt(i);
    if (c >= 48 && c <= 57) cur = (cur < 0 ? 0 : cur) * 10 + (c - 48);
    else if (c === 44) {
      if (cur < 0) throw new Error('Empty value in PoolByteArray');
      out[n++] = cur;
      cur = -1;
    } else if (c !== 32) throw new Error(`Unexpected character in PoolByteArray: ${b[i]}`);
  }
  if (cur >= 0) out[n++] = cur;
  return out.slice(0, n);
}

export function formatByteArray(v: Uint8Array): string {
  return v.length ? `PoolByteArray( ${Array.from(v).join(', ')} )` : 'PoolByteArray(  )';
}

/**
 * Dungeondraft colours are ARGB hex ("ff726e65"). Accepts "#RRGGBB", "RRGGBB", "#AARRGGBB"/"AARRGGBB"
 * (8 digits are read as Dungeondraft-style ARGB), returns lowercase ARGB.
 */
export function toArgb(color: string): string {
  const c = color.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{6}$/.test(c)) return `ff${c}`;
  if (/^[0-9a-f]{8}$/.test(c)) return c;
  throw new Error(`Colour must be "#RRGGBB" or Dungeondraft ARGB "AARRGGBB", got ${JSON.stringify(color)}`);
}

/** ARGB -> "#rrggbb" plus alpha 0..1 */
export function argbToCss(argb: string): { hex: string; alpha: number } {
  const c = toArgb(argb);
  return { hex: `#${c.slice(2)}`, alpha: parseInt(c.slice(0, 2), 16) / 255 };
}
