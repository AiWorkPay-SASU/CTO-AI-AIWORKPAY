// Generates integrations/aiworkpay/tools.manifest.json from the REAL pinned MCP server (read-only tools/list).
// Usage: AIWORKPAY_MCP_DIR=/path/to/built/aiworkpay-mcp-server node scripts/gen-mcp-manifest.js
import fs from 'node:fs';
import path from 'node:path';
import { Client } from '../integrations/aiworkpay/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../integrations/aiworkpay/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';
import { describeTool } from '../integrations/aiworkpay/mcp-port.js';

const dir = process.env.AIWORKPAY_MCP_DIR;
if (!dir) { console.error('Set AIWORKPAY_MCP_DIR'); process.exit(2); }
const pin = JSON.parse(fs.readFileSync(new URL('../integrations/aiworkpay/MCP_PIN.json', import.meta.url), 'utf8'));
const transport = new StdioClientTransport({
  command: process.execPath, args: [path.join(dir, 'dist', 'index.js')], stderr: 'ignore',
  env: { AIWORKPAY_BASE_URL: 'http://127.0.0.1:9', AIWORKPAY_API_KEY: 'awp_manifest_generation_only_not_a_key' }
});
const client = new Client({ name: 'manifest-generator', version: '0.1.0' });
await client.connect(transport);
const { tools } = await client.listTools();
const info = client.getServerVersion();
await client.close();
const manifest = { server: { ...pin.server, name: info.name, version: info.version }, tools: Object.fromEntries(tools.sort((a, b) => a.name.localeCompare(b.name)).map((t) => [t.name, describeTool(t)])) };
fs.writeFileSync(new URL('../integrations/aiworkpay/tools.manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest: ${tools.length} tools, server ${info.name}@${info.version}`);
