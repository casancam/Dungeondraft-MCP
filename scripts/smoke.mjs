// End-to-end check over MCP stdio against a temp copy of the test map.
// Usage: npm run build && node scripts/smoke.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ddmcp-smoke-'));
fs.copyFileSync(path.join(here, '../test/fixtures/mcp_test.dungeondraft_map'), path.join(root, 'mcp_test.dungeondraft_map'));
const vtt = path.join(here, '../test/fixtures/external/ambush.dd2vtt');
if (fs.existsSync(vtt)) fs.copyFileSync(vtt, path.join(root, 'ambush.dd2vtt'));

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(here, '../dist/index.js')], env: { ...process.env, DD_MCP_ROOTS: root } }));

const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  console.log(`\n### ${name}${r.isError ? ' (ERROR)' : ''}\n${text.length > 900 ? text.slice(0, 900) + ' …' : text}`);
  return r;
};

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));
await call('list-maps', {});
await call('list-assets', { query: 'table', category: 'objects', limit: 3 });
await call('add-walls', { path: 'mcp_test.dungeondraft_map', walls: [{ points: [[12, 6], [22, 6], [22, 13], [12, 13]], loop: true, doors: [{ at: [17, 13] }] }] });
await call('add-objects', { path: 'mcp_test.dungeondraft_map', objects: [{ asset: 'res://textures/objects/activities/administration/atlas_globe_01.png', at: [17, 9.5] }] });
await call('add-lights', { path: 'mcp_test.dungeondraft_map', lights: [{ at: [17, 9.5], range: 6 }] });
await call('add-objects', { path: 'mcp_test.dungeondraft_map', objects: [{ asset: 'res://textures/objects/does_not_exist.png', at: [1, 1] }] });
await call('inspect-map', { path: 'mcp_test.dungeondraft_map', list: ['walls', 'doors', 'lights'] });
await call('remove-elements', { path: 'mcp_test.dungeondraft_map', types: ['lights'], area: { x: 0, y: 0, width: 35, height: 20 }, dry_run: true });
await call('duplicate-map', { path: 'mcp_test.dungeondraft_map', new_name: 'mcp_test_night' });
await call('list-maps', { folder: '../' });
if (fs.existsSync(vtt)) await call('dd2vtt-to-foundry-scene', { path: 'ambush.dd2vtt', image_src: 'maps/ambush.png' });
console.log('\nfiles in root:', fs.readdirSync(root).join(', '));
await client.close();
