import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssetCatalog } from '../src/assets/catalog.js';
import { loadConfig } from '../src/config.js';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
export const EXTERNAL = path.join(FIXTURES, 'external');
export const USER_MAP = path.join(FIXTURES, 'mcp_test.dungeondraft_map');

/** All sample maps present on disk (external ones are downloaded by `npm run fixtures`). */
export function sampleMaps(): string[] {
  const ext = fs.existsSync(EXTERNAL) ? fs.readdirSync(EXTERNAL).filter((f) => f.endsWith('.dungeondraft_map')).map((f) => path.join(EXTERNAL, f)) : [];
  return [USER_MAP, ...ext];
}

export function external(name: string): string | null {
  const p = path.join(EXTERNAL, name);
  return fs.existsSync(p) ? p : null;
}

/** Copy a fixture into a fresh temp folder that acts as the sandbox root. */
export function tempCopy(src: string, name = path.basename(src)): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ddmcp-'));
  const file = path.join(dir, name);
  fs.copyFileSync(src, file);
  return { dir, file };
}

const installDir = (() => {
  try {
    return loadConfig({ DD_MCP_ROOTS: os.tmpdir() }).installDir;
  } catch {
    return undefined;
  }
})();
export const HAS_DUNGEONDRAFT = Boolean(installDir);

/** Catalog with the real built-in assets when Dungeondraft is installed, otherwise unvalidated. */
export function catalog(): AssetCatalog {
  return new AssetCatalog({ installDir, assetDirs: [] });
}
