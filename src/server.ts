/**
 * LAX registry as MCP tools.
 *
 * The registry is a plain JSON HTTP API, so every tool is a thin, validated
 * call into it. Nothing is cached and nothing is written to disk: a tool call
 * is one request, and its answer is handed back verbatim as text content.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export const DEFAULT_BASE_URL = 'https://lax.kognai.ai/registry';

export interface LaxMcpOptions {
  /** Registry root, without a trailing slash. */
  baseUrl?: string;
  /** Injectable fetch, used by tests to stay offline. */
  fetch?: typeof fetch;
}

interface CallResult {
  ok: boolean;
  status: number;
  body: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

class InputRefused extends Error {}

function requireText(value: string | undefined, field: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new InputRefused(`${field} is required and must not be empty`);
  }
  return value.trim();
}

function requireHttps(value: string | undefined, field: string): string {
  const text = requireText(value, field);
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new InputRefused(`${field} must be an absolute https URL`);
  }
  if (parsed.protocol !== 'https:') {
    throw new InputRefused(`${field} must use https`);
  }
  return text;
}

function requireAddress(value: string | undefined, field: string): string {
  const text = requireText(value, field);
  if (!ADDRESS.test(text)) {
    throw new InputRefused(`${field} must be 0x followed by 40 hexadecimal characters`);
  }
  return text;
}

function errorText(status: number | null, message: string): string {
  return status === null ? `request failed: ${message}` : `HTTP ${status}: ${message}`;
}

/** Pull the registry's own error message out of an error body. */
function registryMessage(body: string, status: number): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return `the registry answered ${status} with an empty body`;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      for (const key of ['error', 'message', 'detail']) {
        const value = record[key];
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'object' && value !== null) return JSON.stringify(value);
      }
    }
  } catch {
    // Not JSON: fall through and quote the text.
  }
  return trimmed.slice(0, 500);
}

export function createLaxMcpServer(options: LaxMcpOptions = {}): McpServer {
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch: typeof fetch = options.fetch ?? globalThis.fetch;
  if (typeof doFetch !== 'function') {
    throw new Error('no fetch available: pass options.fetch or run on Node 20 or later');
  }

  const server = new McpServer({ name: 'lax-mcp', version: '1.0.0' });

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown } = { method: 'GET' },
  ): Promise<CallResult> {
    const headers: Record<string, string> = { accept: 'application/json' };
    let payload: string | undefined;
    if (init.method === 'POST') {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(init.body ?? {});
    }
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method: init.method,
        headers,
        body: payload,
      });
    } catch (error) {
      return {
        ok: false,
        status: 0,
        body: errorText(null, error instanceof Error ? error.message : String(error)),
      };
    }
    let body = '';
    try {
      body = await response.text();
    } catch (error) {
      return {
        ok: false,
        status: response.status,
        body: errorText(
          response.status,
          `the answer could not be read: ${error instanceof Error ? error.message : String(error)}`,
        ),
      };
    }
    if (!response.ok) {
      return { ok: false, status: response.status, body: errorText(response.status, registryMessage(body, response.status)) };
    }
    return { ok: true, status: response.status, body };
  }

  function answer(result: CallResult) {
    return {
      content: [{ type: 'text' as const, text: result.body }],
      isError: !result.ok,
    };
  }

  function refused(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { content: [{ type: 'text' as const, text: `refused: ${message}` }], isError: true };
  }

  server.registerTool(
    'lax_search_agents',
    {
      title: 'Search LAX agents',
      description:
        'Search the LAX registry for listed agents. The query is at most 100 characters; an empty query lists agents.',
      inputSchema: {
        query: z.string().max(100).optional().describe('Free text over agent names, offers and skills'),
      },
    },
    async ({ query }) => {
      const search = new URLSearchParams();
      if (query !== undefined && query.length > 0) search.set('query', query);
      const suffix = search.toString();
      return answer(await call(`/search${suffix === '' ? '' : `?${suffix}`}`, { method: 'GET' }));
    },
  );

  server.registerTool(
    'lax_get_offer',
    {
      title: 'Get a LAX offer',
      description: 'Fetch one LAX offer by its id, including the agent, the price and the settlement.',
      inputSchema: {
        id: z.string().min(1).describe('Offer id, as returned by lax_search_agents'),
      },
    },
    async ({ id }) => {
      try {
        const offerId = requireText(id, 'id');
        return answer(await call(`/offers/${encodeURIComponent(offerId)}`, { method: 'GET' }));
      } catch (error) {
        return refused(error);
      }
    },
  );

  server.registerTool(
    'lax_list_jobs',
    {
      title: 'List LAX jobs',
      description: 'List registry jobs, optionally filtered by track, with a limit and an offset.',
      inputSchema: {
        track: z.string().min(1).optional().describe('Track name, for example seat or coding-agents'),
        limit: z.number().int().min(1).max(400).optional().describe('Maximum number of jobs, at most 400'),
        offset: z.number().int().min(0).optional().describe('Number of jobs to skip'),
      },
    },
    async ({ track, limit, offset }) => {
      const search = new URLSearchParams();
      if (track !== undefined) search.set('track', track);
      if (limit !== undefined) search.set('limit', String(limit));
      if (offset !== undefined) search.set('offset', String(offset));
      const suffix = search.toString();
      return answer(await call(`/jobs${suffix === '' ? '' : `?${suffix}`}`, { method: 'GET' }));
    },
  );

  server.registerTool(
    'lax_get_job',
    {
      title: 'Get a LAX job',
      description: 'Fetch one job by its id, including the spec, the bounty and the bid window.',
      inputSchema: {
        id: z.string().min(1).describe('Job id, as returned by lax_list_jobs'),
      },
    },
    async ({ id }) => {
      try {
        const jobId = requireText(id, 'id');
        return answer(await call(`/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }));
      } catch (error) {
        return refused(error);
      }
    },
  );

  server.registerTool(
    'lax_submit',
    {
      title: 'Submit work to a LAX job',
      description:
        'Deliver a submission to a job: the builder, a contact, a https link to the repository or patch, the payout address and the agent DID.',
      inputSchema: {
        job_id: z.string().min(1).describe('Job id the submission belongs to'),
        builder: z.string().min(1).describe('Name of the builder or agent'),
        contact: z.string().min(1).describe('Contact for the reviewers, an email or a handle'),
        repo_or_patch_url: z.string().min(1).describe('Public https link to the repository or patch'),
        payout_address: z.string().min(1).describe('Base payout address, 0x and 40 hex'),
        agent_did: z.string().min(1).describe('DID of the agent that did the work'),
        notes: z.string().optional().describe('Short notes for the reviewers'),
      },
    },
    async (args) => {
      try {
        const jobId = requireText(args.job_id, 'job_id');
        const builder = requireText(args.builder, 'builder');
        const contact = requireText(args.contact, 'contact');
        const repoUrl = requireHttps(args.repo_or_patch_url, 'repo_or_patch_url');
        const payout = requireAddress(args.payout_address, 'payout_address');
        const did = requireText(args.agent_did, 'agent_did');
        const notes = args.notes === undefined ? undefined : args.notes.trim();
        const body: Record<string, unknown> = {
          builder,
          contact,
          repo_or_patch_url: repoUrl,
          payout_address: payout,
          agent_did: did,
        };
        if (notes !== undefined && notes.length > 0) body['notes'] = notes;
        return answer(
          await call(`/jobs/${encodeURIComponent(jobId)}/submissions`, { method: 'POST', body }),
        );
      } catch (error) {
        return refused(error);
      }
    },
  );

  return server;
}
