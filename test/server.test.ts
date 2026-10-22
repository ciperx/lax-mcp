import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLaxMcpServer } from '../dist/server.js';

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (recorded: Recorded) => { status: number; body: string } | Promise<{ status: number; body: string }>;

function fakeFetch(handler: Handler) {
  const calls: Recorded[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers ?? {};
    if (Array.isArray(rawHeaders)) {
      for (const [key, value] of rawHeaders) headers[key.toLowerCase()] = value;
    } else if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
    } else {
      for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = String(value);
    }
    const body = init?.body === undefined || init.body === null ? undefined : JSON.parse(String(init.body));
    const recorded: Recorded = { url, method: init?.method ?? 'GET', body, headers };
    calls.push(recorded);
    const result = await handler(recorded);
    return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
  };
  return { fn: fn as unknown as typeof fetch, calls };
}

async function connect(fetchImpl: typeof fetch = globalThis.fetch) {
  const server = createLaxMcpServer({ baseUrl: 'https://registry.test/registry', fetch: fetchImpl });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function text(result: unknown): string {
  const content = (result as { content?: { text?: string }[] }).content ?? [];
  return content.map((item) => item.text ?? '').join('\n');
}

test('A1 tools/list returns the five tools with a description and an input schema', async () => {
  const { client, close } = await connect();
  try {
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      'lax_get_job',
      'lax_get_offer',
      'lax_list_jobs',
      'lax_search_agents',
      'lax_submit',
    ]);
    for (const tool of listed.tools) {
      assert.ok((tool.description ?? '').length > 10, `${tool.name} needs a description`);
      assert.equal(tool.inputSchema?.type, 'object', `${tool.name} needs an object schema`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    }
  } finally {
    await close();
  }
});

test('A2 every tool calls its registry route with the given arguments', async () => {
  const { fn, calls } = fakeFetch((recorded) => {
    if (recorded.method === 'POST') return { status: 201, body: '{"submission_id":"s1"}' };
    if (recorded.url.includes('/offers/')) return { status: 200, body: '{"id":"o1"}' };
    if (recorded.url.includes('/search')) return { status: 200, body: '{"agents":[{"id":"a1"}]}' };
    if (recorded.url.endsWith('/registry/jobs/j1')) return { status: 200, body: '{"id":"j1"}' };
    return { status: 200, body: '{"jobs":[]}' };
  });
  const { client, close } = await connect(fn);
  try {
    const search = await client.callTool({ name: 'lax_search_agents', arguments: { query: 'scraper' } });
    assert.equal(text(search).includes('agents'), true);
    const offer = await client.callTool({ name: 'lax_get_offer', arguments: { id: 'o1' } });
    assert.equal(text(offer).includes('"id":"o1"'), true);
    const jobs = await client.callTool({ name: 'lax_list_jobs', arguments: { track: 'seat', limit: 5, offset: 10 } });
    assert.equal(text(jobs).includes('jobs'), true);
    const job = await client.callTool({ name: 'lax_get_job', arguments: { id: 'j1' } });
    assert.equal(text(job).includes('"id":"j1"'), true);
    const submit = await client.callTool({
      name: 'lax_submit',
      arguments: {
        job_id: 'j1',
        builder: 'ciperx agent',
        contact: 'agent@example.test',
        repo_or_patch_url: 'https://github.com/ciperx/lax-mcp',
        payout_address: '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
        agent_did: 'did:key:z6Mkexample',
        notes: 'M1',
      },
    });
    assert.equal(text(submit).includes('submission_id'), true);

    const byPath = calls.map((call) => `${call.method} ${call.url.replace('https://registry.test/registry', '')}`);
    assert.deepEqual(byPath, [
      'GET /search?query=scraper',
      'GET /offers/o1',
      'GET /jobs?track=seat&limit=5&offset=10',
      'GET /jobs/j1',
      'POST /jobs/j1/submissions',
    ]);
    const posted = calls[4]?.body as Record<string, unknown>;
    assert.equal(posted['job_id'], undefined, 'job_id belongs in the path, not the body');
    assert.equal(posted['builder'], 'ciperx agent');
    assert.equal(posted['repo_or_patch_url'], 'https://github.com/ciperx/lax-mcp');
  } finally {
    await close();
  }
});

test('A3 a 4xx answer and a network failure give isError with the status, and the next call works', async () => {
  let mode: 'fail' | 'ok' = 'fail';
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (mode === 'fail') {
      if (url.includes('/jobs/missing')) {
        return new Response('{"error":"job not found"}', { status: 404, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('socket hang up');
    }
    return new Response('{"jobs":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  const { client, close } = await connect(fetchImpl);
  try {
    const missing = (await client.callTool({ name: 'lax_get_job', arguments: { id: 'missing' } })) as {
      isError?: boolean;
    };
    assert.equal(missing.isError, true);
    assert.match(text(missing), /HTTP 404: job not found/);

    const broken = (await client.callTool({ name: 'lax_list_jobs', arguments: {} })) as { isError?: boolean };
    assert.equal(broken.isError, true);
    assert.match(text(broken), /request failed: socket hang up/);

    mode = 'ok';
    const recovered = (await client.callTool({ name: 'lax_list_jobs', arguments: {} })) as { isError?: boolean };
    assert.equal(recovered.isError, false);
  } finally {
    await close();
  }
});

test('A4 invalid input is refused without a request', async () => {
  const { fn, calls } = fakeFetch(() => ({ status: 200, body: '{}' }));
  const { client, close } = await connect(fn);
  try {
    const badAddress = (await client.callTool({
      name: 'lax_submit',
      arguments: {
        job_id: 'j1',
        builder: 'b',
        contact: 'c',
        repo_or_patch_url: 'https://example.test/repo',
        payout_address: '0x123',
        agent_did: 'did:key:z',
      },
    })) as { isError?: boolean };
    assert.equal(badAddress.isError, true);
    assert.match(text(badAddress), /payout_address must be 0x followed by 40 hexadecimal characters/);

    const badLink = (await client.callTool({
      name: 'lax_submit',
      arguments: {
        job_id: 'j1',
        builder: 'b',
        contact: 'c',
        repo_or_patch_url: 'http://example.test/repo',
        payout_address: '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
        agent_did: 'did:key:z',
      },
    })) as { isError?: boolean };
    assert.equal(badLink.isError, true);
    assert.match(text(badLink), /repo_or_patch_url must use https/);

    const missingId = (await client.callTool({ name: 'lax_get_job', arguments: { id: '  ' } })) as {
      isError?: boolean;
    };
    assert.equal(missingId.isError, true);
    assert.match(text(missingId), /id is required/);
    assert.equal(calls.length, 0, 'a refused input must not reach the registry');
  } finally {
    await close();
  }
});

test('A5 no contact, payout address or header appears in a log line', async () => {
  const lines: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  const { fn } = fakeFetch(() => ({ status: 201, body: '{"submission_id":"s1"}' }));
  try {
    const { client, close } = await connect(fn);
    await client.callTool({
      name: 'lax_submit',
      arguments: {
        job_id: 'j1',
        builder: 'b',
        contact: 'agent@example.test',
        repo_or_patch_url: 'https://example.test/repo',
        payout_address: '0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e',
        agent_did: 'did:key:z',
      },
    });
    await close();
  } finally {
    process.stderr.write = original;
  }
  const joined = lines.join('');
  assert.equal(joined.includes('agent@example.test'), false);
  assert.equal(joined.includes('0x27EbD1DDCB6607bE8641784A1bf654623Fc8290e'), false);
});

test('A6 the package exposes a bin with a shebang and both transports are reachable', async () => {
  const { readFile } = await import('node:fs/promises');
  const raw = await readFile(new URL('../package.json', import.meta.url), 'utf8');
  const manifest = JSON.parse(raw) as { bin?: Record<string, string>; exports?: Record<string, unknown> };
  assert.equal(manifest.bin?.['lax-mcp'], './dist/bin.js');
  const bin = await readFile(new URL('../dist/bin.js', import.meta.url), 'utf8');
  assert.equal(bin.startsWith('#!/usr/bin/env node'), true);
  assert.match(bin, /StdioServerTransport/);
  assert.match(bin, /StreamableHTTPServerTransport/);
  assert.ok(manifest.exports?.['.']);
});
