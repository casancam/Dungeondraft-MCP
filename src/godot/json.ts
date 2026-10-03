/**
 * Order-preserving JSON parser and a printer that reproduces Godot 3's `JSON.print(data, "\t")`.
 *
 * Why not JSON.parse/JSON.stringify:
 *  - JS objects hoist integer-like keys ("100" before "-400"), which reorders `layers`/`materials`.
 *    We record each object's original key order in a hidden symbol.
 *  - A primitive whose JSON.stringify differs from the source text (e.g. "1e-05", escaped unicode)
 *    keeps its original token, so untouched values are written back byte-for-byte.
 *
 * Godot's printer: tab indentation, `"key": value`, an empty array/object prints as an opening
 * bracket, a blank line, then the closing bracket, and the file ends with "\n".
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

const KEY_ORDER = Symbol('keyOrder');
const RAW = Symbol('rawTokens');

type Annotated = { [KEY_ORDER]?: string[]; [RAW]?: Map<string | number, string> };

function hide(target: object, sym: symbol, value: unknown): void {
  Object.defineProperty(target, sym, { value, enumerable: false, writable: true, configurable: true });
}

function rememberRaw(container: object, key: string | number, value: JsonPrimitive, raw: string): void {
  if (JSON.stringify(value) === raw) return;
  const c = container as Annotated;
  let m = c[RAW];
  if (!m) {
    m = new Map();
    hide(container, RAW, m);
  }
  m.set(key, raw);
}

export class GodotJsonError extends Error {}

export function parseGodotJson(text: string): JsonValue {
  let i = 0;
  const n = text.length;

  const fail = (msg: string): never => {
    const line = text.slice(0, i).split('\n').length;
    throw new GodotJsonError(`Invalid map JSON at line ${line}: ${msg}`);
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  // Returns [value, rawToken]; raw is only meaningful for primitives.
  const value = (): [JsonValue, string] => {
    ws();
    const c = text[i];
    if (c === '{') return [object(), ''];
    if (c === '[') return [array(), ''];
    const start = i;
    if (c === '"') {
      const s = string();
      return [s, text.slice(start, i)];
    }
    if (text.startsWith('true', i)) {
      i += 4;
      return [true, 'true'];
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return [false, 'false'];
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return [null, 'null'];
    }
    const m = /-?\d+(\.\d+)?([eE][-+]?\d+)?/y;
    m.lastIndex = i;
    const r = m.exec(text);
    if (!r) fail(`unexpected character ${JSON.stringify(c ?? 'EOF')}`);
    i += r![0].length;
    return [Number(r![0]), r![0]];
  };
  const string = (): string => {
    // Fast path: find the closing quote, delegate escapes to JSON.parse.
    const start = i;
    i++;
    let escaped = false;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 92) {
        escaped = true;
        i += 2;
        continue;
      }
      if (c === 34) break;
      i++;
    }
    if (i >= n) fail('unterminated string');
    i++;
    const raw = text.slice(start, i);
    return escaped ? (JSON.parse(raw) as string) : raw.slice(1, -1);
  };
  const object = (): JsonObject => {
    i++;
    const obj: JsonObject = {};
    const order: string[] = [];
    hide(obj, KEY_ORDER, order);
    ws();
    if (text[i] === '}') {
      i++;
      return obj;
    }
    for (;;) {
      ws();
      if (text[i] !== '"') fail('expected object key');
      const key = string();
      ws();
      if (text[i] !== ':') fail('expected ":"');
      i++;
      const [v, raw] = value();
      if (key === '__proto__') Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
      else obj[key] = v;
      if (!order.includes(key)) order.push(key);
      if (v === null || typeof v !== 'object') rememberRaw(obj, key, v as JsonPrimitive, raw);
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return obj;
      }
      fail('expected "," or "}"');
    }
  };
  const array = (): JsonValue[] => {
    i++;
    const arr: JsonValue[] = [];
    ws();
    if (text[i] === ']') {
      i++;
      return arr;
    }
    for (;;) {
      const [v, raw] = value();
      if (v === null || typeof v !== 'object') rememberRaw(arr, arr.length, v as JsonPrimitive, raw);
      arr.push(v);
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return arr;
      }
      fail('expected "," or "]"');
    }
  };

  const result = value()[0];
  ws();
  if (i !== n) fail('trailing content after JSON value');
  return result;
}

/** Keys in original order first (if still present), then keys added since parsing. */
export function orderedKeys(obj: JsonObject): string[] {
  const order = (obj as Annotated)[KEY_ORDER];
  const own = Object.keys(obj);
  if (!order) return own;
  const present = new Set(own);
  const out = order.filter((k) => present.has(k));
  const seen = new Set(out);
  for (const k of own) if (!seen.has(k)) out.push(k);
  return out;
}

function primitive(container: object, key: string | number, v: JsonPrimitive): string {
  const raw = (container as Annotated)[RAW]?.get(key);
  // Use the original token only if it still denotes the current value.
  if (raw !== undefined && JSON.parse(raw) === v) return raw;
  if (typeof v === 'number' && !Number.isFinite(v)) throw new GodotJsonError(`Cannot write non-finite number ${v}`);
  return JSON.stringify(v);
}

function print(v: JsonValue, depth: number, out: string[]): void {
  if (Array.isArray(v)) {
    const pad = '\t'.repeat(depth);
    if (v.length === 0) {
      out.push('[\n\n', pad, ']');
      return;
    }
    out.push('[\n');
    for (let k = 0; k < v.length; k++) {
      out.push(pad, '\t');
      const x = v[k];
      if (x !== null && typeof x === 'object') print(x, depth + 1, out);
      else out.push(primitive(v, k, x));
      out.push(k < v.length - 1 ? ',\n' : '\n');
    }
    out.push(pad, ']');
    return;
  }
  if (v !== null && typeof v === 'object') {
    const pad = '\t'.repeat(depth);
    const keys = orderedKeys(v);
    if (keys.length === 0) {
      out.push('{\n\n', pad, '}');
      return;
    }
    out.push('{\n');
    keys.forEach((k, idx) => {
      out.push(pad, '\t', JSON.stringify(k), ': ');
      const x = v[k];
      if (x !== null && typeof x === 'object') print(x, depth + 1, out);
      else out.push(primitive(v, k, x as JsonPrimitive));
      out.push(idx < keys.length - 1 ? ',\n' : '\n');
    });
    out.push(pad, '}');
    return;
  }
  out.push(JSON.stringify(v));
}

/** Serialise a value in Godot's format. `depth` lets callers print a nested section on its own. */
export function printGodotJson(v: JsonValue, opts: { trailingNewline?: boolean; depth?: number } = {}): string {
  const out: string[] = [];
  print(v, opts.depth ?? 0, out);
  if (opts.trailingNewline ?? true) out.push('\n');
  return out.join('');
}
