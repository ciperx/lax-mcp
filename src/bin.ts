#!/usr/bin/env node
/**
 * lax-mcp bin.
 *
 *   lax-mcp                 stdio server (default)
 *   lax-mcp --http          Streamable HTTP server, POST /mcp
 *   lax-mcp --http --port 8788
 */
import { createServer as createHttpServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLaxMcpServer } from "./index.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

async function runStdio(): Promise<void> {
  const server = createLaxMcpServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write("[lax-mcp] stdio ready\n");
}

async function runHttp(port: number): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    if (!req.url || !req.url.startsWith("/mcp")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: unknown;
    try {
      parsed = body === "" ? undefined : JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid json" }));
      return;
    }
    const server = createLaxMcpServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });

  await new Promise<void>((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
  process.stderr.write(`[lax-mcp] http ready on port ${port} at /mcp\n`);
}

const wantHttp = process.argv.includes("--http");
const port = Number(argValue("--port") ?? process.env.PORT ?? 8788);

if (wantHttp) {
  await runHttp(Number.isFinite(port) && port > 0 ? port : 8788);
} else {
  await runStdio();
}
