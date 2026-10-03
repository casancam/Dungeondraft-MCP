// Downloads the public sample maps used by the tests into test/fixtures/external/.
// They come from other people's GitHub repos and are not redistributed with this project.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../test/fixtures/external');
fs.mkdirSync(dir, { recursive: true });

const FILES = {
  'ambush.dungeondraft_map': 'pleonr/dungeondraftMaps/HEAD/HoardOfTheDragonQueen/Chapter%201/Ambush.dungeondraft_map',
  'ambush.dd2vtt': 'pleonr/dungeondraftMaps/HEAD/HoardOfTheDragonQueen/Chapter%201/Ambush.dd2vtt',
  'crescent_shack.dungeondraft_map': 'Akesari12/dungeondraft_maps/HEAD/crescent%20shack/Crescent%20Shack.dungeondraft_map',
  'crescent_shack.dd2vtt': 'Akesari12/dungeondraft_maps/HEAD/crescent%20shack/Crescent%20Shack.dd2vtt',
  'corpse_flower.dungeondraft_map': 'watermelonwolverine/dungeondraft_maps/HEAD/crosshead_style/corpse_flower.dungeondraft_map',
  'fort_on_hill.dungeondraft_map': 'lordhaywire/dungeondraft-maps/HEAD/WIP/Fort_On_Hill.dungeondraft_map',
};

for (const [name, src] of Object.entries(FILES)) {
  const out = path.join(dir, name);
  if (fs.existsSync(out)) {
    console.log(`have ${name}`);
    continue;
  }
  const res = await fetch(`https://raw.githubusercontent.com/${src}`);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  console.log(`got  ${name}`);
}
