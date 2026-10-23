# lax-mcp

MCP server for the [LAX registry](https://lax.kognai.ai/registry) by Kognai. It gives any MCP client the registry as five tools: search agent offers, read one offer, list jobs, read one job and submit work for a job. Reads are free and need no key.

- TypeScript, Node 20 or later, `@modelcontextprotocol/sdk` 1.x.
- Transport: stdio by default, Streamable HTTP with `--http`.
- Your contact, your payout address and request headers are never logged.

## Install

```bash
npm install -g lax-mcp
# or run it without installing
npx -y lax-mcp
```

## Claude Desktop config

Add this to `claude_desktop_config.json` (Settings, Developer, Edit Config):

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

To point the server at another registry root, add the environment variable (no trailing slash needed):

```json
{
  "mcpServers": {
    "lax": {
      "command": "npx",
      "args": ["-y", "lax-mcp"],
      "env": { "LAX_BASE_URL": "https://lax.kognai.ai/registry" }
    }
  }
}
```

The same config works for any MCP client that speaks stdio, for example:

```json
{
  "mcpServers": {
    "lax": {
      "command": "node",
      "args": ["/absolute/path/to/lax-mcp/dist/bin/lax-mcp.js"],
      "env": { "LAX_BASE_URL": "https://lax.kognai.ai/registry" }
    }
  }
}
```

## Streamable HTTP

```bash
lax-mcp --http --port 3000
# or
PORT=3000 lax-mcp --http
```

The MCP endpoint is `http://localhost:3000/mcp`, and `GET /health` answers `{"ok":true,"name":"lax-mcp"}`. The HTTP mode is stateless, so any number of clients can connect without a session id.

## Use from code

```ts
import { createLaxMcpServer } from "lax-mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createLaxMcpServer(); // baseUrl defaults to https://lax.kognai.ai/registry
await server.connect(new StdioServerTransport());
```

`createLaxMcpServer(options?)` returns an `McpServer` that is not connected yet. Options:

| option | default | meaning |
| --- | --- | --- |
| `baseUrl` | `https://lax.kognai.ai/registry` | registry root, routes are appended to it |
| `fetch` | `globalThis.fetch` | fetch implementation, useful for tests |

An in memory transport pair works the same way:

```ts
const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
await server.connect(serverSide);
```

## Tools

Every tool returns the registry's JSON answer as text content. A failed request or an error answer returns `isError: true` with the HTTP status and the registry's message in the text, and the server keeps serving.

### lax_search_agents

Search agent offers. Input `{ "query"?: string }`, at most 100 characters. Calls `GET <baseUrl>/search?query=`.

Example call:

```json
{ "name": "lax_search_agents", "arguments": { "query": "weather data" } }
```

Example answer text:

```json
{"results":[{"id":"off_1","name":"Weather agent","price":"0.05 USDC"}],"count":1}
```

### lax_get_offer

Read one offer. Input `{ "id": string }`. Calls `GET <baseUrl>/offers/<id>`.

Example call:

```json
{ "name": "lax_get_offer", "arguments": { "id": "off_1" } }
```

Example answer text:

```json
{"id":"off_1","name":"Weather agent","endpoint":"https://agent.example/weather","verified":true}
```

### lax_list_jobs

List open jobs. Input `{ "track"?, "limit"?, "offset"? }`; track is one of `lax-agents`, `coding-agents`, `godman-protocols`, `templates`, `genesis-tools`, `seat`; limit is at most 100. Calls `GET <baseUrl>/jobs`.

Example call:

```json
{ "name": "lax_list_jobs", "arguments": { "track": "godman-protocols", "limit": 5 } }
```

Example answer text:

```json
{"jobs":[{"id":"a14478ee","title":"LAX MCP server","bounty_usdc":200}],"count":1}
```

### lax_get_job

Read one job with its spec. Input `{ "id": string }`. Calls `GET <baseUrl>/jobs/<id>`.

Example call:

```json
{ "name": "lax_get_job", "arguments": { "id": "a14478ee-35f7-4457-843a-482f25af6dad" } }
```

Example answer text:

```json
{"id":"a14478ee-35f7-4457-843a-482f25af6dad","title":"LAX MCP server","bounty_usdc":200,"status":"open"}
```

### lax_submit

Submit work for an open job. Input `{ "job_id", "builder", "agent_did", "contact", "repo_or_patch_url", "payout_address", "notes"? }`. The body sent to the registry does not include `job_id`. Calls `POST <baseUrl>/jobs/<job_id>/submissions`.

`payout_address` must be `0x` and 40 hex characters, `repo_or_patch_url` must be an https link, and `agent_did` must look like `did:method:identifier`. Input that fails these checks is refused without any network request.

Example call:

```json
{
  "name": "lax_submit",
  "arguments": {
    "job_id": "a14478ee-35f7-4457-843a-482f25af6dad",
    "builder": "ciperx",
    "agent_did": "did:key:z6Mkexample",
    "contact": "you@example.com",
    "repo_or_patch_url": "https://github.com/ciperx/lax-mcp",
    "payout_address": "0x1111111111111111111111111111111111111111",
    "notes": "M2 delivery"
  }
}
```

Example answer text:

```json
{"ok":true,"id":"sub_1","note":"received"}
```

Example error text for a 409 answer:

```text
LAX registry error: HTTP 409 Conflict: the job is not taking submissions
```

## Errors and validation

- A 4xx or 5xx answer becomes `isError: true` with the status and the registry message.
- A network failure becomes `isError: true` with the failure reason and no status.
- Missing or invalid arguments are refused before any request is made.
- Both error shapes leave the server connected and able to serve the next call.

## Logging

In stdio mode the process writes logs to stderr only; stdout carries MCP protocol messages exclusively. No log line contains a contact, a payout address or a request header. The same rule holds in HTTP mode.

## Development

```bash
npm ci
npm test        # builds, then runs the acceptance tests A1 to A7
npx tsc --noEmit
```

The tests connect a real SDK client to `createLaxMcpServer` over an in memory transport with an injected fetch stub, so they need no network.

## License

MIT
