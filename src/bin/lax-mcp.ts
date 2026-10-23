#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLaxMcpServer } from "../server.js";

const log = (line: string): void => {
  // stderr only: stdout belongs to the MCP protocol in stdio mode.
  process.stderr.write(`lax-mcp: ${line}\n`);
};

interface CliOptions {
  http: boolean;
  port: number;
}

function parseArgs(argv: string[]): CliOptions {
  let http = false;
  let port: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--http") {
      http = true;
    } else if (arg === "--port") {
      const next = argv[i + 1];
      if (next === undefined) throw new Error("--port needs a value");
      port = Number(next);
      i += 1;
    } else if (arg.startsWith("--port=")) {
      port = Number(arg.slice("--port=".length));
    } else if (arg === "--help" || arg === "-h") {
      process.stderr.write(
        "usage: lax-mcp [--http] [--port <n>]  (stdio is the default; PORT env is honoured with --http)\n",
      );
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  const fromEnv = process.env.PORT ? Number(process.env.PORT) : undefined;
  const resolvedPort = port ?? fromEnv ?? 3000;
  if (!Number.isInteger(resolvedPort) || resolvedPort < 1 || resolvedPort > 65535) {
    throw new Error("port must be an integer between 1 and 65535");
  }
  return { http, port: resolvedPort };
}

async function runStdio(): Promise<void> {
  const baseUrl = process.env.LAX_BASE_URL || undefined;
  const server = createLaxMcpServer({ baseUrl });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log("ready on stdio");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function runHttp(port: number): Promise<void> {
  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname === "/health") {
        sendJson(res, 200, { ok: true, name: "lax-mcp" });
        return;
      }
      if (url.pathname !== "/mcp" && url.pathname !== "/") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      // Stateless Streamable HTTP: one server and transport per request.
      const server = createLaxMcpServer({
        baseUrl: process.env.LAX_BASE_URL || undefined,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      const body = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`http request failed: ${message}`);
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, () => resolve());
  });
  log(`ready on streamable http at http://localhost:${port}/mcp`);
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(message);
    process.exit(2);
  }
  if (options.http) {
    await runHttp(options.port);
  } else {
    await runStdio();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  log(`fatal: ${message}`);
  process.exit(1);
});
