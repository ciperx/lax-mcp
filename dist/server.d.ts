import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
export declare const DEFAULT_BASE_URL = "https://lax.kognai.ai/registry";
export interface LaxMcpServerOptions {
    /** Registry root. Defaults to https://lax.kognai.ai/registry */
    baseUrl?: string;
    /** fetch implementation. Defaults to globalThis.fetch */
    fetch?: typeof globalThis.fetch;
}
/**
 * Build the LAX MCP server. The returned McpServer is not connected yet; pass
 * it a transport (stdio, Streamable HTTP or an in memory pair) to start.
 */
export declare function createLaxMcpServer(options?: LaxMcpServerOptions): McpServer;
export default createLaxMcpServer;
