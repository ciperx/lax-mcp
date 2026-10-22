import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/bin.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});
const client = new Client({ name: 'live-smoke', version: '1.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(','));
const jobs = await client.callTool({ name: 'lax_list_jobs', arguments: { limit: 3 } });
const textOut = (jobs.content ?? []).map((c) => c.text ?? '').join('');
console.log('isError:', jobs.isError ?? false);
console.log('jobs head:', textOut.slice(0, 220));
await client.close();
