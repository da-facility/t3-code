import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";

/**
 * A stand-in T3 server for hub tests: a streamable-HTTP MCP endpoint with a
 * few orchestration tools and the pairing-token route.
 */
export interface FakeT3 {
  url: string;
  calls: Array<{ tool: string; args: Record<string, unknown> }>;
  pairingRequests: unknown[];
  state: {
    threads: Array<{
      threadId: string;
      title: string;
      status: string;
      pendingRequestCount: number;
    }>;
    pending: Array<{ requestId: string; summary: string }>;
  };
  close: () => Promise<void>;
}

const TOOLS = [
  "t3_environment_read",
  "t3_project_list",
  "t3_thread_list",
  "t3_thread_launch",
  "t3_pending_request",
  "delegate_task",
].map((name) => ({
  name,
  description: `fake ${name}`,
  inputSchema: {
    type: "object",
    properties: { threadId: { type: "string" } },
    required: [] as string[],
  },
}));

export async function startFakeT3(mcpToken: string, bearerToken: string): Promise<FakeT3> {
  const fake: Omit<FakeT3, "url" | "close"> = {
    calls: [],
    pairingRequests: [],
    state: { threads: [], pending: [] },
  };
  const results: Record<string, (args: Record<string, unknown>) => unknown> = {
    t3_environment_read: () => ({ environmentId: "env-a", serverVersion: "0.0.0-test" }),
    t3_project_list: () => ({ projects: [{ id: "p1", title: "Project" }], nextCursor: null }),
    t3_thread_list: () => ({ threads: fake.state.threads }),
    t3_thread_launch: (args) => ({ threadId: "t-new", status: "preparing", title: args.title }),
    t3_pending_request: () => ({ requests: fake.state.pending }),
  };

  const server = NodeHttp.createServer((request, response) => {
    let text = "";
    request.on("data", (chunk) => (text += chunk));
    request.on("end", () => {
      if (request.url === "/api/auth/pairing-token") {
        if (request.headers.authorization !== `Bearer ${bearerToken}`) {
          response.writeHead(401).end();
          return;
        }
        fake.pairingRequests.push(JSON.parse(text));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ id: "pl1", credential: "PAIRCODE", expiresAt: "2030-01-01T00:00:00Z" }),
        );
        return;
      }
      if (request.headers.authorization !== `Bearer ${mcpToken}`) {
        response.writeHead(401).end();
        return;
      }
      const message = JSON.parse(text) as {
        id?: number;
        method: string;
        params?: Record<string, unknown>;
      };
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = {
          protocolVersion: "2025-06-18",
          capabilities: {},
          serverInfo: { name: "fake", version: "1" },
        };
        response.setHeader("mcp-session-id", "s1");
      } else if (message.method === "tools/list") {
        result = { tools: TOOLS };
      } else {
        const name = String(message.params?.name);
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        fake.calls.push({ tool: name, args });
        const value = results[name]?.(args) ?? { message: "unknown" };
        result = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        };
      }
      // Answer as an SSE stream, like the real server does.
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    ...fake,
    url: `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
