import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseGodotJson, printGodotJson, type JsonObject } from '../src/godot/json.js';
import { sampleMaps } from './helpers.js';

describe('Godot JSON round-trip', () => {
  for (const file of sampleMaps()) {
    it(`reproduces ${path.basename(file)} byte-for-byte`, () => {
      const text = fs.readFileSync(file, 'utf8');
      expect(printGodotJson(parseGodotJson(text))).toBe(text);
    });
  }

  it('keeps integer-like keys in file order (JS would hoist them)', () => {
    const text = '{\n\t"-400": "Below Ground",\n\t"100": "User Layer 1"\n}\n';
    const v = parseGodotJson(text) as JsonObject;
    expect(Object.keys(v)).toEqual(['100', '-400']); // JS order
    expect(printGodotJson(v)).toBe(text); // file order
  });

  it('appends new keys after existing ones and drops deleted keys', () => {
    const v = parseGodotJson('{\n\t"b": 1,\n\t"a": 2\n}\n') as JsonObject;
    v.c = 3;
    delete v.b;
    expect(printGodotJson(v)).toBe('{\n\t"a": 2,\n\t"c": 3\n}\n');
  });

  it('keeps original number/string tokens that JSON.stringify would rewrite', () => {
    const text = '{\n\t"n": 1e-05,\n\t"f": 2.50,\n\t"s": "caf\\u00e9"\n}\n';
    const v = parseGodotJson(text) as JsonObject;
    expect(v.n).toBe(0.00001);
    expect(v.s).toBe('café');
    expect(printGodotJson(v)).toBe(text);
    v.f = 3;
    expect(printGodotJson(v)).toContain('"f": 3');
  });

  it('prints empty containers the Godot way', () => {
    expect(printGodotJson({ a: [], b: {} } as JsonObject, { trailingNewline: false })).toBe('{\n\t"a": [\n\n\t],\n\t"b": {\n\n\t}\n}');
  });

  it('reports the line of a syntax error', () => {
    expect(() => parseGodotJson('{\n\t"a": 1,\n\t"b": ?\n}')).toThrow(/line 3/);
  });
});
