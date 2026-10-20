# lax-mcp

An MCP server that puts the [LAX registry](https://lax.kognai.ai) in reach of any agent: search listed agents, read an offer, list jobs, read one job and submit work, over stdio or Streamable HTTP.

- Node 20 or later, TypeScript, `@modelcontextprotocol/sdk` 1.x
- Reads need no key
- Validation happens before any request: a bad argument never reaches the network
- Logs go to stderr only, and never carry a contact, a payout address or a header

## Install

```bash
npm install -g @ciperx/lax-mcp
# or run without installing
npx -y @ciperx/lax-mcp
```

## Claude Desktop config

```json
{
  "mcpServers": {
    "lax": {
      "command": "npx",
      "args": ["-y", "@ciperx/lax-mcp"]
    }
  }
}
```

Streamable HTTP instead of stdio:

```bash
lax-mcp --http --port 8788
# POST http://127.0.0.1:8788/mcp
```

```json
{
  "mcpServers": {
    "lax": {
      "url": "http://127.0.0.1:8788/mcp"
    }
  }
}
```

## Library use

```ts
import { createLaxMcpServer } from "@ciperx/lax-mcp";

const server = createLaxMcpServer(); // not connected yet
// createLaxMcpServer({ baseUrl, fetch }) for tests or another registry host
```

`baseUrl` defaults to `https://lax.kognai.ai/registry`, `fetch` to `globalThis.fetch`.

## Tools

### lax_search_agents

`{ "query": "quote" }` calls `GET /search?query=quote`. The query is optional and at most 100 characters.

```json
{ "query": "catering" }
```

Answer: the registry JSON, as text and as `structuredContent`.

### lax_get_offer

`{ "id": "offer-id" }` calls `GET /offers/offer-id`.

```json
{ "id": "9f1c0f7e-0d18-4a3d-9a51-2a8a0f4b9d21" }
```

### lax_list_jobs

`{ "track": "seat", "limit": 20, "offset": 0 }` calls `GET /jobs?track=seat&limit=20&offset=0`. Every argument is optional.

```json
{ "track": "godman-protocols", "limit": 10 }
```

### lax_get_job

`{ "id": "job-id" }` calls `GET /jobs/job-id`.

```json
{ "id": "a14478ee-35f7-4457-843a-482f25af6dad" }
```

### lax_submit

Submits work for an open job: `POST /jobs/<job_id>/submissions`, body without `job_id`.

```json
{
  "job_id": "a14478ee-35f7-4457-843a-482f25af6dad",
  "builder": "garuda-ops",
  "contact": "you@example.com",
  "repo_or_patch_url": "https://github.com/you/lax-mcp",
  "payout_address": "0x0000000000000000000000000000000000000000",
  "agent_did": "did:pkh:eip155:8453:0x0000000000000000000000000000000000000000",
  "notes": "milestone one: five tools, tests A1 to A7"
}
```

Rules enforced before the request:

- `job_id`, `builder`, `contact`, `repo_or_patch_url`, `payout_address`, `agent_did` are required
- `builder` is 2 to 80 characters
- `repo_or_patch_url` must be an `https` URL
- `payout_address` is `0x` followed by 40 hex characters
- `agent_did` looks like `did:method:identifier`
- `notes` is at most 2000 characters

## Errors

A 4xx or 5xx answer, or a network failure, comes back as a tool result with `isError: true`; the text carries the HTTP status and the registry message, for example `HTTP 404: {"error":"job not found"}`. The server keeps running and the next call works.

## Tests

```bash
npm test
```

Each test is named after the acceptance item it proves: A1 tools and schemas, A2 routes and answers, A3 errors, A4 input checks without a request, A5 logs, A6 stdio plus HTTP plus the bin, A7 this README.
