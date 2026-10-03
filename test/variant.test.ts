import { describe, expect, it } from 'vitest';
import {
  argbToCss,
  formatByteArray,
  formatReal,
  formatVector2,
  formatVector2Array,
  parseByteArray,
  parseIntArray,
  parseVector2,
  parseVector2Array,
  toArgb,
} from '../src/godot/variant.js';

describe('Godot var2str codec', () => {
  it('parses and formats Vector2 like Dungeondraft', () => {
    expect(parseVector2('Vector2( 4042.05, 4530.46 )')).toEqual([4042.05, 4530.46]);
    expect(formatVector2([7040, 5120])).toBe('Vector2( 7040, 5120 )');
    expect(formatVector2([-19.70701, 5.431641])).toBe('Vector2( -19.707, 5.43164 )');
  });

  it('handles PoolVector2Array including the empty form', () => {
    const s = 'PoolVector2Array( 6912, 5120, 7168, 5120 )';
    expect(parseVector2Array(s)).toEqual([
      [6912, 5120],
      [7168, 5120],
    ]);
    expect(formatVector2Array(parseVector2Array(s))).toBe(s);
    expect(parseVector2Array('PoolVector2Array(  )')).toEqual([]);
    expect(formatVector2Array([])).toBe('PoolVector2Array(  )');
  });

  it('round-trips byte and int arrays', () => {
    const s = 'PoolByteArray( 255, 0, 0, 0, 12 )';
    expect(Array.from(parseByteArray(s))).toEqual([255, 0, 0, 0, 12]);
    expect(formatByteArray(parseByteArray(s))).toBe(s);
    expect(parseIntArray('PoolIntArray( -1, 3 )')).toEqual([-1, 3]);
  });

  it('rejects the wrong type', () => {
    expect(() => parseVector2('PoolVector2Array( 1, 2 )')).toThrow(/Vector2/);
  });

  it('formats reals with ~6 significant digits', () => {
    expect(formatReal(10236.3333)).toBe('10236.3');
    expect(formatReal(0.1234567)).toBe('0.123457');
    expect(formatReal(256)).toBe('256');
  });

  it('converts colours between CSS and Dungeondraft ARGB', () => {
    expect(toArgb('#ECCD8B')).toBe('ffeccd8b');
    expect(toArgb('7f000000')).toBe('7f000000');
    expect(() => toArgb('red')).toThrow();
    expect(argbToCss('7f102030')).toEqual({ hex: '#102030', alpha: 127 / 255 });
  });
});
