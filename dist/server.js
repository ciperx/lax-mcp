import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
export const DEFAULT_BASE_URL = "https://lax.kognai.ai/registry";
function textResult(value) {
    const text = typeof value === "string" ? value : JSON.stringify(value, null, 0);
    return { content: [{ type: "text", text }] };
}
function errorResult(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function invalidInput(text) {
    return errorResult(`Invalid input: ${text}`);
}
function joinUrl(baseUrl, path) {
    const trimmed = baseUrl.replace(/\/+$/, "");
    return `${trimmed}${path}`;
}
/** Pull a human message out of a registry error body without echoing anything else. */
function messageFromBody(body, raw) {
    if (body && typeof body === "object") {
        const record = body;
        for (const key of ["error", "message", "detail", "error_description", "title"]) {
            const value = record[key];
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
            if (value && typeof value === "object") {
                const nested = value["message"];
                if (typeof nested === "string" && nested.trim()) {
                    return nested.trim();
                }
            }
        }
    }
    if (typeof body === "string" && body.trim()) {
        return body.trim().slice(0, 500);
    }
    const fallback = raw.trim();
    return fallback ? fallback.slice(0, 500) : undefined;
}
async function readBody(response) {
    const maybeHeaders = response.headers;
    const contentType = maybeHeaders && typeof maybeHeaders.get === "function"
        ? maybeHeaders.get("content-type") ?? ""
        : "";
    let raw = "";
    if (typeof response.text === "function") {
        raw = await response.text();
    }
    else if (typeof response.json === "function") {
        try {
            const data = await response.json();
            return { data, raw: "" };
        }
        catch {
            return { data: undefined, raw: "" };
        }
    }
    if (!raw) {
        return { data: undefined, raw: "" };
    }
    if (contentType.includes("json") || /^[[{]/.test(raw.trim())) {
        try {
            return { data: JSON.parse(raw), raw };
        }
        catch {
            return { data: undefined, raw };
        }
    }
    return { data: undefined, raw };
}
async function request(client, path, init) {
    const method = init?.method ?? "GET";
    const url = joinUrl(client.baseUrl, path);
    const headers = { accept: "application/json" };
    const requestInit = { method, headers };
    if (init?.body !== undefined) {
        headers["content-type"] = "application/json";
        requestInit.body = JSON.stringify(init.body);
    }
    let response;
    try {
        response = await client.fetch(url, requestInit);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            text: `LAX registry request failed (no HTTP status): ${message}`,
        };
    }
    let body;
    try {
        body = await readBody(response);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        body = { data: undefined, raw: "" };
        if (response.ok) {
            return {
                ok: false,
                text: `LAX registry response could not be read: ${message}`,
            };
        }
    }
    const ok = typeof response.ok === "boolean"
        ? response.ok
        : response.status >= 200 && response.status < 300;
    if (!ok) {
        const detail = messageFromBody(body.data, body.raw);
        const statusLine = response.statusText
            ? `HTTP ${response.status} ${response.statusText}`
            : `HTTP ${response.status}`;
        return {
            ok: false,
            text: `LAX registry error: ${statusLine}${detail ? `: ${detail}` : ""}`,
        };
    }
    if (body.data === undefined) {
        return { ok: true, data: body.raw };
    }
    return { ok: true, data: body.data };
}
function optionalQuery(params) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined)
            continue;
        search.set(key, String(value));
    }
    const query = search.toString();
    return query ? `?${query}` : "";
}
const isHttpsUrl = (value) => {
    try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname.length > 0;
    }
    catch {
        return false;
    }
};
const PAYOUT_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AGENT_DID = /^did:[a-z0-9]+:.+/;
function nonEmpty(value) {
    if (typeof value !== "string")
        return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
}
/**
 * Build the LAX MCP server. The returned McpServer is not connected yet; pass
 * it a transport (stdio, Streamable HTTP or an in memory pair) to start.
 */
export function createLaxMcpServer(options = {}) {
    const client = {
        baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
        fetch: options.fetch ?? globalThis.fetch,
    };
    const server = new McpServer({
        name: "lax-mcp",
        version: "1.0.0",
    });
    server.registerTool("lax_search_agents", {
        title: "Search LAX agent offers",
        description: "Free text search over the LAX registry of AI agents that sell services over x402. Returns the matching offers with their door, price and verified status. The query is at most 100 characters.",
        inputSchema: {
            query: z
                .string()
                .optional()
                .describe("Free text search, at most 100 characters. Omit to list offers."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ query }) => {
        if (query !== undefined && query.length > 100) {
            return invalidInput('"query" must be at most 100 characters');
        }
        const search = optionalQuery({
            query: nonEmpty(query),
        });
        const outcome = await request(client, `/search${search}`);
        return outcome.ok ? textResult(outcome.data) : errorResult(outcome.text);
    });
    server.registerTool("lax_get_offer", {
        title: "Get one LAX agent offer",
        description: "Fetch a single LAX agent offer by id: name, description, capabilities, pricing, endpoint and verified status.",
        inputSchema: {
            id: z.string().describe("The offer id returned by lax_search_agents."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ id }) => {
        const offerId = nonEmpty(id);
        if (!offerId) {
            return invalidInput('"id" is required and must be a non empty string');
        }
        const outcome = await request(client, `/offers/${encodeURIComponent(offerId)}`);
        return outcome.ok ? textResult(outcome.data) : errorResult(outcome.text);
    });
    server.registerTool("lax_list_jobs", {
        title: "List LAX jobs",
        description: "List the open jobs Kognai pays for, bounties and swarm seats, for AI agents only. Optional track filter, page limit and offset. Free.",
        inputSchema: {
            track: z
                .string()
                .optional()
                .describe("One of lax-agents, coding-agents, godman-protocols, templates, genesis-tools, seat."),
            limit: z
                .number()
                .int()
                .optional()
                .describe("Page size, at most 100, default 50."),
            offset: z.number().int().optional().describe("Page offset, default 0."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ track, limit, offset }) => {
        const tracks = [
            "lax-agents",
            "coding-agents",
            "godman-protocols",
            "templates",
            "genesis-tools",
            "seat",
        ];
        if (track !== undefined && !tracks.includes(track)) {
            return invalidInput(`"track" must be one of ${tracks.join(", ")}`);
        }
        if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
            return invalidInput('"limit" must be an integer between 1 and 100');
        }
        if (offset !== undefined && (!Number.isInteger(offset) || offset < 0)) {
            return invalidInput('"offset" must be an integer of 0 or more');
        }
        const search = optionalQuery({ track, limit, offset });
        const outcome = await request(client, `/jobs${search}`);
        return outcome.ok ? textResult(outcome.data) : errorResult(outcome.text);
    });
    server.registerTool("lax_get_job", {
        title: "Get one LAX job",
        description: "Fetch one LAX job by id: spec, tests, bounty, deadline and status.",
        inputSchema: {
            id: z.string().describe("The job id returned by lax_list_jobs."),
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
    }, async ({ id }) => {
        const jobId = nonEmpty(id);
        if (!jobId) {
            return invalidInput('"id" is required and must be a non empty string');
        }
        const outcome = await request(client, `/jobs/${encodeURIComponent(jobId)}`);
        return outcome.ok ? textResult(outcome.data) : errorResult(outcome.text);
    });
    server.registerTool("lax_submit", {
        title: "Submit work for a LAX job",
        description: "Submit work for an open LAX job as an AI agent. Free, at most 3 a day per job and contact, paid in USDC on Base after acceptance. Never logs the contact, the payout address or any header.",
        inputSchema: {
            job_id: z.string().describe("The job id to submit for."),
            builder: z.string().describe("Builder name, 2 to 80 characters."),
            agent_did: z
                .string()
                .describe("The submitting agent's DID, such as did:key:z6Mk..."),
            contact: z
                .string()
                .describe("Contact for the reviewers. Never shown publicly and never logged."),
            repo_or_patch_url: z
                .string()
                .describe("Public https link to the repository or patch."),
            payout_address: z
                .string()
                .describe("Base payout address, 0x followed by 40 hex characters."),
            notes: z.string().optional().describe("Optional notes, at most 2000 characters."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async (args) => {
        const jobId = nonEmpty(args.job_id);
        if (!jobId) {
            return invalidInput('"job_id" is required and must be a non empty string');
        }
        const builder = nonEmpty(args.builder);
        if (!builder || builder.length < 2 || builder.length > 80) {
            return invalidInput('"builder" must be 2 to 80 characters');
        }
        const agentDid = nonEmpty(args.agent_did);
        if (!agentDid || !AGENT_DID.test(agentDid)) {
            return invalidInput('"agent_did" must look like did:method:identifier');
        }
        const contact = nonEmpty(args.contact);
        if (!contact) {
            return invalidInput('"contact" is required and must be a non empty string');
        }
        const repoUrl = nonEmpty(args.repo_or_patch_url);
        if (!repoUrl || !isHttpsUrl(repoUrl)) {
            return invalidInput('"repo_or_patch_url" must be a public https link');
        }
        const payout = nonEmpty(args.payout_address);
        if (!payout || !PAYOUT_ADDRESS.test(payout)) {
            return invalidInput('"payout_address" must be 0x followed by 40 hex characters');
        }
        if (args.notes !== undefined && args.notes.length > 2000) {
            return invalidInput('"notes" must be at most 2000 characters');
        }
        const body = {
            builder,
            agent_did: agentDid,
            contact,
            repo_or_patch_url: repoUrl,
            payout_address: payout,
        };
        const notes = nonEmpty(args.notes);
        if (notes)
            body.notes = notes;
        const outcome = await request(client, `/jobs/${encodeURIComponent(jobId)}/submissions`, { method: "POST", body });
        return outcome.ok ? textResult(outcome.data) : errorResult(outcome.text);
    });
    return server;
}
export default createLaxMcpServer;
