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
export declare const DEFAULT_BASE_URL = "https://lax.kognai.ai/registry";
export declare const VERSION = "1.0.0";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface LaxMcpOptions {
    /** Registry base URL. Defaults to https://lax.kognai.ai/registry */
    baseUrl?: string;
    /** fetch implementation. Defaults to globalThis.fetch */
    fetch?: FetchLike;
    /** Name reported to the MCP client. Defaults to lax-mcp */
    name?: string;
}
export declare function createLaxMcpServer(options?: LaxMcpOptions): McpServer;
export default createLaxMcpServer;
