import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import { createLaxMcpServer } from "../dist/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const binPath = join(root, "dist", "bin", "lax-mcp.js");

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: RecordedCall) => Response | Promise<Response>;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface Harness {
  client: Client;
  server: ReturnType<typeof createLaxMcpServer>;
  calls: RecordedCall[];
  close: () => Promise<void>;
}

const harnesses: Harness[] = [];

async function connect(handler: Handler): Promise<Harness> {
  const calls: RecordedCall[] = [];
  const stubFetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) {
      headers[key.toLowerCase()] = String(value);
    }
    const call: RecordedCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return handler(call);
  }) as typeof globalThis.fetch;

  const server = createLaxMcpServer({
    baseUrl: "https://stub.test/registry",
    fetch: stubFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "lax-mcp-tests", version: "1.0.0" });
  await client.connect(clientTransport);

  const harness: Harness = {
    client,
    server,
    calls,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      if (address === null || typeof address === "string") {
        socket.close();
        reject(new Error("no port"));
        return;
      }
      const port = address.port;
      socket.close(() => resolve(port));
    });
  });
}

afterEach(async () => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop();
    if (harness) await harness.close().catch(() => undefined);
  }
});

describe("lax-mcp acceptance", () => {
  it("A1 lists the five tools with a description and an input schema", async () => {
    const { client } = await connect(() => jsonResponse({ ok: true }));
    const listed = await client.listTools();
    const names = listed.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "lax_get_job",
      "lax_get_offer",
      "lax_list_jobs",
      "lax_search_agents",
      "lax_submit",
    ]);
    for (const tool of listed.tools) {
      expect(tool.description ?? "").not.toBe("");
      expect(tool.inputSchema).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(Object.keys(tool.inputSchema.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("A2 calls each registry route with the given arguments and returns the answer", async () => {
    const answers: Record<string, unknown> = {
      "/search": { results: [{ id: "off_1" }], count: 1 },
      "/offers/off_1": { id: "off_1", name: "Weather agent" },
      "/jobs": { jobs: [{ id: "job_1" }], count: 1 },
      "/jobs/job_1": { id: "job_1", title: "Weather data" },
      "/jobs/job_1/submissions": { ok: true, id: "sub_1" },
    };
    const { client, calls } = await connect((call) => {
      const path = new URL(call.url).pathname.replace("/registry", "");
      return jsonResponse(answers[path] ?? {});
    });

    const search = await client.callTool({
      name: "lax_search_agents",
      arguments: { query: "weather agent" },
    });
    expect(textOf(search)).toBe(JSON.stringify(answers["/search"]));
    const searchUrl = new URL(calls[0]!.url);
    expect(searchUrl.origin + searchUrl.pathname).toBe(
      "https://stub.test/registry/search",
    );
    expect(searchUrl.searchParams.get("query")).toBe("weather agent");

    const offer = await client.callTool({
      name: "lax_get_offer",
      arguments: { id: "off_1" },
    });
    expect(textOf(offer)).toBe(JSON.stringify(answers["/offers/off_1"]));
    expect(calls[1]!.url).toBe("https://stub.test/registry/offers/off_1");

    const jobs = await client.callTool({
      name: "lax_list_jobs",
      arguments: { track: "seat", limit: 5, offset: 10 },
    });
    expect(textOf(jobs)).toBe(JSON.stringify(answers["/jobs"]));
    const jobsUrl = new URL(calls[2]!.url);
    expect(jobsUrl.pathname).toBe("/registry/jobs");
    expect(jobsUrl.searchParams.get("track")).toBe("seat");
    expect(jobsUrl.searchParams.get("limit")).toBe("5");
    expect(jobsUrl.searchParams.get("offset")).toBe("10");

    const job = await client.callTool({
      name: "lax_get_job",
      arguments: { id: "job_1" },
    });
    expect(textOf(job)).toBe(JSON.stringify(answers["/jobs/job_1"]));
    expect(calls[3]!.url).toBe("https://stub.test/registry/jobs/job_1");

    const submitted = await client.callTool({
      name: "lax_submit",
      arguments: {
        job_id: "job_1",
        builder: "ciperx",
        contact: "agent@example.test",
        repo_or_patch_url: "https://github.com/ciperx/lax-mcp",
        payout_address: "0x1111111111111111111111111111111111111111",
        agent_did: "did:key:z6Mktest",
        notes: "M2",
      },
    });
    expect(submitted.isError ?? false).toBe(false);
    expect(textOf(submitted)).toBe(JSON.stringify(answers["/jobs/job_1/submissions"]));
    const submitCall = calls[4]!;
    expect(submitCall.method).toBe("POST");
    expect(submitCall.url).toBe(
      "https://stub.test/registry/jobs/job_1/submissions",
    );
    expect(submitCall.headers["content-type"]).toBe("application/json");
    expect(submitCall.body).toEqual({
      builder: "ciperx",
      contact: "agent@example.test",
      repo_or_patch_url: "https://github.com/ciperx/lax-mcp",
      payout_address: "0x1111111111111111111111111111111111111111",
      agent_did: "did:key:z6Mktest",
      notes: "M2",
    });
    expect(submitCall.body).not.toHaveProperty("job_id");
  });

  it("A3 returns isError with the status and message, and the next call still works", async () => {
    let mode: "fail" | "throw" | "ok" = "fail";
    const { client, calls } = await connect(() => {
      if (mode === "fail") return jsonResponse({ error: "job not found" }, 404);
      if (mode === "throw") throw new TypeError("fetch failed");
      return jsonResponse({ jobs: [], count: 0 });
    });

    const failed = await client.callTool({
      name: "lax_get_job",
      arguments: { id: "missing" },
    });
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("404");
    expect(textOf(failed)).toContain("job not found");

    mode = "throw";
    const thrown = await client.callTool({
      name: "lax_list_jobs",
      arguments: {},
    });
    expect(thrown.isError).toBe(true);
    expect(textOf(thrown)).toContain("fetch failed");

    mode = "ok";
    const recovered = await client.callTool({
      name: "lax_list_jobs",
      arguments: {},
    });
    expect(recovered.isError ?? false).toBe(false);
    expect(JSON.parse(textOf(recovered))).toEqual({ jobs: [], count: 0 });
    expect(calls.length).toBe(3);

    const listed = await client.listTools();
    expect(listed.tools.length).toBe(5);
  });

  it("A4 refuses invalid input without a request", async () => {
    const { client, calls } = await connect(() => jsonResponse({ ok: true }));

    const missingId = await client.callTool({
      name: "lax_get_job",
      arguments: { id: "" },
    });
    expect(missingId.isError).toBe(true);

    const badPayout = await client.callTool({
      name: "lax_submit",
      arguments: {
        job_id: "job_1",
        builder: "ciperx",
        contact: "agent@example.test",
        repo_or_patch_url: "https://github.com/ciperx/lax-mcp",
        payout_address: "0x1234",
        agent_did: "did:key:z6Mktest",
      },
    });
    expect(badPayout.isError).toBe(true);

    const badLink = await client.callTool({
      name: "lax_submit",
      arguments: {
        job_id: "job_1",
        builder: "ciperx",
        contact: "agent@example.test",
        repo_or_patch_url: "http://github.com/ciperx/lax-mcp",
        payout_address: "0x1111111111111111111111111111111111111111",
        agent_did: "did:key:z6Mktest",
      },
    });
    expect(badLink.isError).toBe(true);

    const omitted = await client.callTool({
      name: "lax_get_offer",
      arguments: {},
    });
    expect(omitted.isError).toBe(true);

    const longQuery = await client.callTool({
      name: "lax_search_agents",
      arguments: { query: "a".repeat(101) },
    });
    expect(longQuery.isError).toBe(true);

    expect(calls.length).toBe(0);
  });

  it(
    "A5 keeps secrets out of logs and writes only protocol messages on stdout",
    { timeout: 30000 },
    async () => {
      const contact = "secret-contact-8f2c@example.test";
      const payout = "0x2222222222222222222222222222222222222222";
      const child = spawn(process.execPath, [binPath], {
        cwd: root,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      const waitFor = (predicate: (buffer: string) => boolean, label: string) =>
        new Promise<void>((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            if (predicate(stdout)) {
              clearInterval(timer);
              resolve();
            } else if (Date.now() - started > 15000) {
              clearInterval(timer);
              reject(new Error(`timeout waiting for ${label}: ${stdout} ${stderr}`));
            }
          }, 50);
        });

      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "a5", version: "1" },
          },
        })}\n`,
      );
      await waitFor((buffer) => buffer.includes('"id":1'), "initialize");
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "lax_submit",
            arguments: {
              job_id: "job_1",
              builder: "ciperx",
              contact,
              repo_or_patch_url: "http://not-https.example/patch",
              payout_address: payout,
              agent_did: "did:key:z6Mktest",
            },
          },
        })}\n`,
      );
      await waitFor((buffer) => buffer.includes('"id":2'), "tool call");
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));

      for (const line of stdout.split("\n").filter((entry) => entry.trim())) {
        const parsed = JSON.parse(line) as { jsonrpc?: string };
        expect(parsed.jsonrpc).toBe("2.0");
      }
      expect(stdout).not.toContain(contact);
      expect(stdout).not.toContain(payout);
      expect(stderr).not.toContain(contact);
      expect(stderr).not.toContain(payout);
      expect(stderr.toLowerCase()).not.toContain("headers");
    },
  );

  it(
    "A6 runs over stdio and Streamable HTTP and ships a bin",
    { timeout: 40000 },
    async () => {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        bin?: Record<string, string>;
      };
      expect(pkg.bin?.["lax-mcp"]).toBe("dist/bin/lax-mcp.js");

      const stdioTransport = new StdioClientTransport({
        command: process.execPath,
        args: [binPath],
        cwd: root,
        stderr: "pipe",
      });
      const stdioClient = new Client({ name: "a6-stdio", version: "1.0.0" });
      await stdioClient.connect(stdioTransport);
      const overStdio = await stdioClient.listTools();
      expect(overStdio.tools.map((tool) => tool.name)).toContain("lax_search_agents");
      await stdioClient.close();

      const port = await freePort();
      const child = spawn(process.execPath, [binPath, "--http", "--port", String(port)], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const ready = await new Promise<boolean>((resolve) => {
        const started = Date.now();
        const timer = setInterval(() => {
          if (stderr.includes("ready on streamable http")) {
            clearInterval(timer);
            resolve(true);
          } else if (Date.now() - started > 15000) {
            clearInterval(timer);
            resolve(false);
          }
        }, 50);
      });
      expect(ready).toBe(true);

      const httpTransport = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      );
      const httpClient = new Client({ name: "a6-http", version: "1.0.0" });
      try {
        await httpClient.connect(httpTransport);
        const overHttp = await httpClient.listTools();
        expect(overHttp.tools.map((tool) => tool.name).sort()).toEqual([
          "lax_get_job",
          "lax_get_offer",
          "lax_list_jobs",
          "lax_search_agents",
          "lax_submit",
        ]);
      } finally {
        await httpClient.close().catch(() => undefined);
        child.kill("SIGTERM");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    },
  );

  it("A7 ships a README with the Claude Desktop config and every tool example", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toContain("mcpServers");
    for (const name of [
      "lax_search_agents",
      "lax_get_offer",
      "lax_list_jobs",
      "lax_get_job",
      "lax_submit",
    ]) {
      expect(readme).toContain(name);
    }
    expect(readme.toLowerCase()).toContain("example");
    expect(readme).toContain("npx");
  });
});
