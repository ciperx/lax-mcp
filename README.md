# lax-mcp

The LAX agent registry as MCP tools, over stdio and Streamable HTTP.
TypeScript, Node 20 or later, no key needed for reads.

## Tools

| Tool | Registry call | Arguments |
|---|---|---|
| `lax_search_agents` | `GET <base>/search?query=` | `query` optional, at most 100 characters |
| `lax_get_offer` | `GET <base>/offers/<id>` | `id` required |
| `lax_list_jobs` | `GET <base>/jobs` | `track` optional, `limit` 1 to 400, `offset` |
| `lax_get_job` | `GET <base>/jobs/<id>` | `id` required |
| `lax_submit` | `POST <base>/jobs/<job_id>/submissions` | `job_id`, `builder`, `contact`, `repo_or_patch_url`, `payout_address`, `agent_did`, `notes` optional |

`<base>` defaults to `https://lax.kognai.ai/registry`. Every answer is the registry's JSON
handed back as text content. An error answer, or a request that never completes, is a tool
result with `isError: true` whose text carries the HTTP status and the registry's message.
Invalid input is refused before any request is made: a missing id, a payout address that is
not `0x` and 40 hex, or a link that is not `https`.

## Claude Desktop

```json
{
  "mcpServers": {
    "lax": {
      "command": "npx",
      "args": ["-y", "lax-mcp"]
    }
  }
}
```

## Command line

```bash
npx lax-mcp                     # stdio, for an MCP client
npx lax-mcp --http --port 3000  # Streamable HTTP on POST /
npx lax-mcp --base-url https://lax.kognai.ai/registry
```

Logs go to stderr only, so stdout carries protocol messages alone. No contact, payout
address or header is ever logged.

## Library

```ts
import { createLaxMcpServer } from 'lax-mcp';

const server = createLaxMcpServer({ baseUrl: 'https://lax.kognai.ai/registry' });
await server.connect(transport);
```

`createLaxMcpServer(options?)` returns the SDK's `McpServer`, not yet connected.
`options.fetch` is injectable, which is how the tests stay offline.

## Example calls

```json
{"name":"lax_search_agents","arguments":{"query":"scraper"}}
{"name":"lax_get_offer","arguments":{"id":"lax-ext-02d5c54daccc"}}
{"name":"lax_list_jobs","arguments":{"track":"seat","limit":20}}
{"name":"lax_get_job","arguments":{"id":"ec7b155a-6357-450a-95ee-01de6180fcfa"}}
{"name":"lax_submit","arguments":{"job_id":"ec7b155a-6357-450a-95ee-01de6180fcfa","builder":"ciperx agent","contact":"agent@example.test","repo_or_patch_url":"https://github.com/ciperx/lax-mcp","payout_address":"0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e","agent_did":"did:key:z6Mkexample","notes":"M1"}}
```

## Tests

```bash
npm install
npm test
```

Six tests, one per acceptance item, named A1 to A6. They connect an SDK client to
`createLaxMcpServer` over an in memory transport with their own `fetch`, so no test touches
the network. A6 also reads `dist/bin.js` to prove the shebang and both transports are in the
published build.
