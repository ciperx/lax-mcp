/**
 * LAX registry MCP server.
 *
 * Exposes five tools over the Kognai LAX registry HTTP API:
 *   lax_search_agents, lax_get_offer, lax_list_jobs, lax_get_job, lax_submit
 *
 * The registry base URL and the fetch implementation are injectable so the
 * server can be exercised without a network.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
export const DEFAULT_BASE_URL = "https://lax.kognai.ai/registry";
export const VERSION = "1.0.0";
const PAYOUT_RE = /^0x[0-9a-fA-F]{40}$/;
const DID_RE = /^did:[a-z0-9]+:.+/;
const HTTPS_RE = /^https:\/\/[^\s]+$/;
function log(line) {
    // Diagnostics go to stderr only: stdout carries protocol messages.
    process.stderr.write(`[lax-mcp] ${line}\n`);
}
function fail(message) {
    return { content: [{ type: "text", text: message }], isError: true };
}
function ok(body) {
    const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
    const result = { content: [{ type: "text", text }] };
    if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        result.structuredContent = body;
    }
    return result;
}
function requireString(value, field) {
    if (typeof value !== "string" || value.trim() === "")
        return null;
    return value;
}
export function createLaxMcpServer(options = {}) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    async function request(method, path, body) {
        const init = { method, headers: { accept: "application/json" } };
        if (body !== undefined) {
            init.headers = { ...init.headers, "content-type": "application/json" };
            init.body = JSON.stringify(body);
        }
        let res;
        try {
            res = await doFetch(baseUrl + path, init);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log(`${method} ${path} network error`);
            return fail(`network error: ${message}`);
        }
        const raw = await res.text();
        let parsed = raw;
        if (raw !== "") {
            try {
                parsed = JSON.parse(raw);
            }
            catch {
                parsed = raw;
            }
        }
        if (!res.ok) {
            const detail = typeof parsed === "string" ? parsed : JSON.stringify(parsed);
            log(`${method} ${path} -> ${res.status}`);
            return fail(`HTTP ${res.status}: ${detail}`);
        }
        log(`${method} ${path} -> ${res.status}`);
        return ok(parsed);
    }
    const server = new McpServer({ name: options.name ?? "lax-mcp", version: VERSION });
    server.registerTool("lax_search_agents", {
        title: "Search LAX agents",
        description: "Search the LAX registry of agents that sell services over x402. Returns the registry answer for GET /search?query=.",
        inputSchema: {
            query: z.string().optional().describe("free text, at most 100 characters"),
        },
    }, async (args) => {
        const query = args.query ?? "";
        if (typeof query !== "string")
            return fail("invalid input: query must be a string");
        if (query.length > 100)
            return fail("invalid input: query must be at most 100 characters");
        const qs = query === "" ? "" : `?query=${encodeURIComponent(query)}`;
        return request("GET", `/search${qs}`);
    });
    server.registerTool("lax_get_offer", {
        title: "Get a LAX offer",
        description: "Fetch one agent offer from the LAX registry by id: GET /offers/<id>.",
        inputSchema: {
            id: z.string().optional().describe("offer id (required)"),
        },
    }, async (args) => {
        const id = requireString(args.id, "id");
        if (!id)
            return fail("invalid input: id is required");
        return request("GET", `/offers/${encodeURIComponent(id)}`);
    });
    server.registerTool("lax_list_jobs", {
        title: "List LAX jobs",
        description: "List jobs published on the LAX registry: GET /jobs?track=&limit=&offset=.",
        inputSchema: {
            track: z.string().optional().describe("optional track filter"),
            limit: z.number().optional().describe("page size"),
            offset: z.number().optional().describe("page offset"),
        },
    }, async (args) => {
        const params = new URLSearchParams();
        if (args.track !== undefined) {
            if (typeof args.track !== "string")
                return fail("invalid input: track must be a string");
            if (args.track !== "")
                params.set("track", args.track);
        }
        for (const key of ["limit", "offset"]) {
            const value = args[key];
            if (value === undefined)
                continue;
            if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
                return fail(`invalid input: ${key} must be a non negative number`);
            }
            params.set(key, String(Math.floor(value)));
        }
        const qs = params.toString();
        return request("GET", `/jobs${qs ? `?${qs}` : ""}`);
    });
    server.registerTool("lax_get_job", {
        title: "Get a LAX job",
        description: "Fetch one job from the LAX registry by id: GET /jobs/<id>.",
        inputSchema: {
            id: z.string().optional().describe("job id (required)"),
        },
    }, async (args) => {
        const id = requireString(args.id, "id");
        if (!id)
            return fail("invalid input: id is required");
        return request("GET", `/jobs/${encodeURIComponent(id)}`);
    });
    server.registerTool("lax_submit", {
        title: "Submit work to a LAX job",
        description: "Submit work for an open LAX job: POST /jobs/<job_id>/submissions. Validation runs before any request is made.",
        inputSchema: {
            job_id: z.string().optional().describe("job id (required)"),
            builder: z.string().optional().describe("builder name, 2 to 80 characters"),
            contact: z.string().optional().describe("contact for the reviewers, never shown publicly"),
            repo_or_patch_url: z.string().optional().describe("public https repository or patch url"),
            payout_address: z.string().optional().describe("0x followed by 40 hex characters"),
            agent_did: z.string().optional().describe("did:method:identifier of the submitting agent"),
            notes: z.string().optional().describe("optional notes, at most 2000 characters"),
        },
    }, async (args) => {
        const jobId = requireString(args.job_id, "job_id");
        if (!jobId)
            return fail("invalid input: job_id is required");
        const builder = requireString(args.builder, "builder");
        if (!builder)
            return fail("invalid input: builder is required");
        if (builder.length < 2 || builder.length > 80)
            return fail("invalid input: builder must be 2 to 80 characters");
        const contact = requireString(args.contact, "contact");
        if (!contact)
            return fail("invalid input: contact is required");
        const repo = requireString(args.repo_or_patch_url, "repo_or_patch_url");
        if (!repo)
            return fail("invalid input: repo_or_patch_url is required");
        if (!HTTPS_RE.test(repo))
            return fail("invalid input: repo_or_patch_url must be an https url");
        const payout = requireString(args.payout_address, "payout_address");
        if (!payout)
            return fail("invalid input: payout_address is required");
        if (!PAYOUT_RE.test(payout))
            return fail("invalid input: payout_address must be 0x followed by 40 hex characters");
        const did = requireString(args.agent_did, "agent_did");
        if (!did)
            return fail("invalid input: agent_did is required");
        if (!DID_RE.test(did))
            return fail("invalid input: agent_did must look like did:method:identifier");
        const notes = args.notes;
        if (notes !== undefined && typeof notes !== "string")
            return fail("invalid input: notes must be a string");
        if (typeof notes === "string" && notes.length > 2000)
            return fail("invalid input: notes must be at most 2000 characters");
        const payload = {
            builder,
            agent_did: did,
            contact,
            repo_or_patch_url: repo,
            payout_address: payout,
        };
        if (typeof notes === "string" && notes !== "")
            payload.notes = notes;
        return request("POST", `/jobs/${encodeURIComponent(jobId)}/submissions`, payload);
    });
    return server;
}
export default createLaxMcpServer;
