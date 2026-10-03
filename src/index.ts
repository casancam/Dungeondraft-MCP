#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { createServer } from './server.js';

async function main() {
  const config = loadConfig();
  const { server } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout is the MCP channel; log to stderr only.
  console.error(`dungeondraft-mcp ready. Map folders: ${config.roots.join('; ')}. Dungeondraft: ${config.installDir ?? 'not found'}. Asset folders: ${config.assetDirs.join('; ') || 'none'}.`);
}

main().catch((e) => {
  console.error(`dungeondraft-mcp failed to start: ${(e as Error).message}`);
  process.exit(1);
});
