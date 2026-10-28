/**
 * The t3 client: how the metaserver talks to a T3 server, over that server's
 * streamable-HTTP `/mcp` endpoint. One session per server; re-initializes
 * when the server forgets it.
 */

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

export class T3ClientError extends Error {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const PROTOCOL_VERSION = "2025-06-18";

async function readJsonRpcResponse(response: Response, id: number): Promise<unknown> {
  const type = response.headers.get("content-type") ?? "";
  const text = await response.text();
  if (type.includes("text/event-stream")) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      const message = JSON.parse(data) as { id?: number };
      if (message.id === id) return message;
    }
    throw new T3ClientError("MCP stream ended without a response");
  }
  return text.length > 0 ? JSON.parse(text) : null;
}

export class T3Client {
  private sessionId: string | null = null;
  private nextId = 1;
  private initializing: Promise<void> | null = null;

  private readonly endpoint: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    endpoint: string,
    token: string,
    fetchImpl: typeof fetch = fetch,
    timeoutMs = 30_000,
  ) {
    this.endpoint = endpoint;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  private headers() {
    return {
      authorization: `Bearer ${this.token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL_VERSION,
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
    };
  }

  private async post(body: unknown, timeoutMs: number) {
    return this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async initialize() {
    this.sessionId = null;
    const id = this.nextId++;
    const response = await this.post(
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "t3-metaserver", version: "1" },
        },
      },
      this.timeoutMs,
    );
    if (!response.ok) {
      throw new T3ClientError(`MCP initialize failed: HTTP ${response.status}`, response.status);
    }
    this.sessionId = response.headers.get("mcp-session-id");
    await readJsonRpcResponse(response, id);
    await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, this.timeoutMs).then(
      (r) => r.body?.cancel(),
    );
  }

  private ensureSession() {
    if (this.sessionId) return Promise.resolve();
    this.initializing ??= this.initialize().finally(() => {
      this.initializing = null;
    });
    return this.initializing;
  }

  async request<T>(method: string, params: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.ensureSession();
      const id = this.nextId++;
      const response = await this.post({ jsonrpc: "2.0", id, method, params }, timeoutMs);
      // A restarted server forgets sessions; start a fresh one once.
      if ((response.status === 404 || response.status === 400) && attempt === 0) {
        await response.body?.cancel();
        this.sessionId = null;
        continue;
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new T3ClientError(
          `MCP ${method} failed: HTTP ${response.status} ${text.slice(0, 200)}`,
          response.status,
        );
      }
      const message = (await readJsonRpcResponse(response, id)) as {
        result?: T;
        error?: { message?: string };
      };
      if (message?.error) throw new T3ClientError(message.error.message ?? `MCP ${method} error`);
      return message?.result as T;
    }
    throw new T3ClientError(`MCP ${method} failed after re-initializing`);
  }

  async listTools(): Promise<McpTool[]> {
    const result = await this.request<{ tools: McpTool[] }>("tools/list", {});
    return result.tools ?? [];
  }

  callTool(name: string, args: unknown, timeoutMs?: number): Promise<McpToolResult> {
    return this.request<McpToolResult>("tools/call", { name, arguments: args ?? {} }, timeoutMs);
  }
}

/** The structured result when the tool returns one, otherwise its text. */
export function toolResultValue(result: McpToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
