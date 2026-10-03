import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** Folders whose maps the server may read and write. */
  roots: string[];
  /** Dungeondraft install folder (read-only; built-in asset index). */
  installDir?: string;
  /** Asset folders with *.dungeondraft_pack files (read-only). */
  assetDirs: string[];
}

const split = (v: string | undefined) => (v ?? '').split(';').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env): Config {
  const roots = split(env.DD_MCP_ROOTS);
  if (!roots.length) roots.push(path.join(os.homedir(), 'Documents'));
  for (const r of roots) if (!fs.existsSync(r)) throw new Error(`Configured map folder does not exist: ${r}`);

  const candidates = env.DUNGEONDRAFT_DIR ? [env.DUNGEONDRAFT_DIR] : ['C:\\Program Files\\Dungeondraft', 'C:\\Program Files (x86)\\Dungeondraft', '/opt/Dungeondraft', '/Applications/Dungeondraft.app/Contents/Resources'];
  const installDir = candidates.find((d) => fs.existsSync(path.join(d, 'Dungeondraft.pck')) || fs.existsSync(path.join(d, 'Dungeondraft.exe')));

  return { roots, installDir, assetDirs: split(env.DD_ASSET_DIRS) };
}
