/**
 * Acceptance tests for the LAX MCP server.
 * Each test is named after the acceptance item it proves (A1 to A7).
 * Run with: npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createLaxMcpServer } from "../dist/index.js";

const BASE = "https://registry.test/registry";

type Call = { url: string; method: string; body?: unknown };

function fakeFetch(status: number, body: unknown, calls: Call[]) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
}

async function connect(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const server = createLaxMcpServer({ baseUrl: BASE, fetch: fetchImpl });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

function textOf(result: any): string {
  return (result.content ?? []).map((part: any) => part.text ?? "").join("\n");
}

test("A1 tools/list returns the five tools with a description and an input schema", async () => {
  const calls: Call[] = [];
  const { client } = await connect(fakeFetch(200, {}, calls));
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["lax_get_job", "lax_get_offer", "lax_list_jobs", "lax_search_agents", "lax_submit"]);
  for (const tool of listed.tools) {
    assert.ok(tool.description && tool.description.length > 10, `${tool.name} needs a description`);
    assert.equal(tool.inputSchema.type, "object");
    assert.ok(tool.inputSchema.properties, `${tool.name} needs properties`);
  }
});

test("A2 every tool calls its registry route and returns the registry answer", async () => {
  const calls: Call[] = [];
  const { client } = await connect(fakeFetch(200, { ok: true, echo: "answer" }, calls));

  const search = await client.callTool({ name: "lax_search_agents", arguments: { query: "quote agent" } });
  assert.equal(calls.at(-1)?.url, `${BASE}/search?query=quote%20agent`);
  assert.match(textOf(search), /"echo": "answer"/);

  const offer = await client.callTool({ name: "lax_get_offer", arguments: { id: "offer-1" } });
  assert.equal(calls.at(-1)?.url, `${BASE}/offers/offer-1`);
  assert.equal(textOf(offer).length > 0, true);

  const list = await client.callTool({ name: "lax_list_jobs", arguments: { track: "seat", limit: 5, offset: 10 } });
  assert.equal(calls.at(-1)?.url, `${BASE}/jobs?track=seat&limit=5&offset=10`);

  const job = await client.callTool({ name: "lax_get_job", arguments: { id: "job-1" } });
  assert.equal(calls.at(-1)?.url, `${BASE}/jobs/job-1`);
  assert.equal(textOf(job).length > 0, true);

  const submit = await client.callTool({
    name: "lax_submit",
    arguments: {
      job_id: "job-1",
      builder: "garuda-ops",
      contact: "ops@example.com",
      repo_or_patch_url: "https://github.com/example/repo",
      payout_address: "0x5033036702CCeeE23b79022e938a41e0452F908a",
      agent_did: "did:pkh:eip155:8453:0x5033036702CCeeE23b79022e938a41e0452F908a",
      notes: "milestone one",
    },
  });
  const last = calls.at(-1);
  assert.equal(last?.url, `${BASE}/jobs/job-1/submissions`);
  assert.equal(last?.method, "POST");
  assert.deepEqual(last?.body, {
    builder: "garuda-ops",
    agent_did: "did:pkh:eip155:8453:0x5033036702CCeeE23b79022e938a41e0452F908a",
    contact: "ops@example.com",
    repo_or_patch_url: "https://github.com/example/repo",
    payout_address: "0x5033036702CCeeE23b79022e938a41e0452F908a",
    notes: "milestone one",
  });
  assert.equal(textOf(submit).length > 0, true);
});

test("A3 a 4xx, a 5xx and a network failure give isError, and the next call still works", async () => {
  const calls: Call[] = [];
  let mode: "404" | "500" | "throw" | "ok" = "404";
  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, method: init?.method ?? "GET" });
    if (mode === "throw") throw new Error("socket hang up");
    if (mode === "404") return new Response(JSON.stringify({ error: "job not found" }), { status: 404 });
    if (mode === "500") return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const { client } = await connect(fetchImpl);

  const notFound = await client.callTool({ name: "lax_get_job", arguments: { id: "missing" } });
  assert.equal(notFound.isError, true);
  assert.match(textOf(notFound), /HTTP 404/);
  assert.match(textOf(notFound), /job not found/);

  mode = "500";
  const boom = await client.callTool({ name: "lax_get_job", arguments: { id: "x" } });
  assert.equal(boom.isError, true);
  assert.match(textOf(boom), /HTTP 500/);
  assert.match(textOf(boom), /boom/);

  mode = "throw";
  const network = await client.callTool({ name: "lax_get_job", arguments: { id: "y" } });
  assert.equal(network.isError, true);
  assert.match(textOf(network), /network error/);
  assert.match(textOf(network), /socket hang up/);

  mode = "ok";
  const recovered = await client.callTool({ name: "lax_get_job", arguments: { id: "z" } });
  assert.notEqual(recovered.isError, true);
  assert.match(textOf(recovered), /"ok": true/);
});

test("A4 invalid input is refused without any request", async () => {
  const calls: Call[] = [];
  const { client } = await connect(fakeFetch(200, { ok: true }, calls));

  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["lax_get_offer", {}, /id is required/],
    ["lax_get_job", { id: "   " }, /id is required/],
    ["lax_search_agents", { query: "x".repeat(101) }, /at most 100 characters/],
    ["lax_list_jobs", { limit: -1 }, /non negative/],
    ["lax_submit", { job_id: "job-1" }, /builder is required/],
    [
      "lax_submit",
      {
        job_id: "job-1",
        builder: "garuda-ops",
        contact: "ops@example.com",
        repo_or_patch_url: "http://insecure.example/repo",
        payout_address: "0x5033036702CCeeE23b79022e938a41e0452F908a",
        agent_did: "did:pkh:eip155:8453:0x5033036702CCeeE23b79022e938a41e0452F908a",
      },
      /https url/,
    ],
    [
      "lax_submit",
      {
        job_id: "job-1",
        builder: "garuda-ops",
        contact: "ops@example.com",
        repo_or_patch_url: "https://github.com/example/repo",
        payout_address: "0x1234",
        agent_did: "did:pkh:eip155:8453:0x5033036702CCeeE23b79022e938a41e0452F908a",
      },
      /40 hex/,
    ],
    [
      "lax_submit",
      {
        job_id: "job-1",
        builder: "garuda-ops",
        contact: "ops@example.com",
        repo_or_patch_url: "https://github.com/example/repo",
        payout_address: "0x5033036702CCeeE23b79022e938a41e0452F908a",
        agent_did: "not-a-did",
      },
      /did:method:identifier/,
    ],
  ];

  for (const [name, args, pattern] of cases) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} should be refused`);
    assert.match(textOf(result), pattern);
  }
  assert.equal(calls.length, 0, "validation must run before any request");
});

test("A5 no contact, payout address or header appears in a log line", async () => {
  const calls: Call[] = [];
  const lines: string[] = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  const originalStdout = process.stdout.write.bind(process.stdout);
  const stdoutLines: string[] = [];
  process.stderr.write = ((chunk: any) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: any) => {
    stdoutLines.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    const { client } = await connect(fakeFetch(200, { ok: true }, calls));
    await client.callTool({
      name: "lax_submit",
      arguments: {
        job_id: "job-1",
        builder: "garuda-ops",
        contact: "secret-contact@example.com",
        repo_or_patch_url: "https://github.com/example/repo",
        payout_address: "0x5033036702CCeeE23b79022e938a41e0452F908a",
        agent_did: "did:pkh:eip155:8453:0x5033036702CCeeE23b79022e938a41e0452F908a",
      },
    });
  } finally {
    process.stderr.write = originalWrite;
    process.stdout.write = originalStdout;
  }
  const joined = lines.join("");
  assert.equal(joined.includes("secret-contact@example.com"), false);
  assert.equal(joined.includes("0x5033036702CCeeE23b79022e938a41e0452F908a"), false);
  assert.equal(/authorization|api[-_]?key|cookie/i.test(joined), false);
  assert.equal(stdoutLines.join("").includes("lax-mcp"), false, "stdout must carry protocol messages only");
});

test("A6 stdio and Streamable HTTP both serve tools/list, and the package has a bin", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(pkg.bin && Object.keys(pkg.bin).length === 1, "package needs one bin");

  const binPath = new URL("../dist/bin.js", import.meta.url).pathname;
  const transport = new StdioClientTransport({ command: process.execPath, args: [binPath] });
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 5);
  await client.close();

  const port = 18000 + Math.floor(Math.random() * 1000);
  const child = spawn(process.execPath, [binPath, "--http", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    let ready = false;
    const started = Date.now();
    while (!ready && Date.now() - started < 15000) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "http-test", version: "1.0.0" } } }),
        });
        if (res.status === 200) ready = true;
      } catch {
        // server not listening yet
      }
    }
    assert.equal(ready, true, "http mode must answer initialize on POST /mcp");
  } finally {
    child.kill("SIGTERM");
  }
});

test("A7 the README documents the Claude Desktop config and every tool with an example", async () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /mcpServers/);
  assert.match(readme, /lax-mcp/);
  for (const tool of ["lax_search_agents", "lax_get_offer", "lax_list_jobs", "lax_get_job", "lax_submit"]) {
    assert.ok(readme.includes(tool), `README needs ${tool}`);
    const index = readme.indexOf(tool);
    const section = readme.slice(index, index + 700);
    assert.match(section, /\{/, `${tool} needs an argument example`);
  }
});
