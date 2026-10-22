#!/usr/bin/env node
/**
 * lax-mcp bin: stdio by default, Streamable HTTP with --http.
 *
 *   lax-mcp                 serve MCP over stdio
 *   lax-mcp --http          serve Streamable HTTP on --port (or PORT, default 3000)
 *   lax-mcp --base-url URL  point the tools at another registry root
 *
 * Logs go to stderr only, so stdout carries protocol messages alone. No contact,
 * payout address or header is ever logged.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLaxMcpServer, DEFAULT_BASE_URL, type LaxMcpOptions } from './server.js';

interface Flags {
  http: boolean;
  port: number;
  baseUrl: string;
}

export function parseFlags(argv: readonly string[]): Flags {
  let http = false;
  let port = Number.parseInt(process.env['PORT'] ?? '3000', 10);
  let baseUrl = process.env['LAX_BASE_URL'] ?? DEFAULT_BASE_URL;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--http') {
      http = true;
    } else if (flag === '--port') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--port needs a number');
      port = Number.parseInt(value, 10);
      index += 1;
    } else if (flag === '--base-url') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--base-url needs a URL');
      baseUrl = value;
      index += 1;
    } else if (flag === '--help' || flag === '-h') {
      process.stderr.write('usage: lax-mcp [--http] [--port N] [--base-url URL]\n');
      process.exit(0);
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('port must be 1 to 65535');
  return { http, port, baseUrl };
}

async function serveStdio(options: LaxMcpOptions): Promise<void> {
  const server = createLaxMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('lax-mcp: stdio ready\n');
}

async function serveHttp(options: LaxMcpOptions, port: number): Promise<void> {
  const httpServer = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'method not allowed' }));
      return;
    }
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      let body: unknown;
      try {
        body = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const server = createLaxMcpServer(options);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      response.on('close', () => {
        void transport.close();
        void server.close();
      });
      server
        .connect(transport)
        .then(() => transport.handleRequest(request, response, body))
        .catch((error: unknown) => {
          process.stderr.write(`lax-mcp: http request failed: ${error instanceof Error ? error.message : String(error)}\n`);
          if (!response.headersSent) {
            response.writeHead(500, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'internal error' }));
          }
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, () => {
      process.stderr.write(`lax-mcp: http ready on port ${port}\n`);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const options: LaxMcpOptions = { baseUrl: flags.baseUrl };
  if (flags.http) await serveHttp(options, flags.port);
  else await serveStdio(options);
}

main().catch((error: unknown) => {
  process.stderr.write(`lax-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
