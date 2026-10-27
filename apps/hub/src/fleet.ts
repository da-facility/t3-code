import type { RegistryServer, RegistryService } from "@t3tools/fleet/registry";

import type { HubDb, Link } from "./db.ts";
import { McpClient, type McpTool, type McpToolResult, toolResultValue } from "./mcpClient.ts";

/**
 * The hub's view of the fleet: the registry plus a live MCP session to every
 * linked T3 server. Agents and phones both go through this.
 */

/** T3 tools the fleet MCP re-exports, renamed `t3_*` -> `fleet_*` with a `server` argument. */
export const PROXIED_TOOLS = new Set([
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_search",
  "t3_thread_read",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_organize",
  "t3_pending_request",
  "t3_queue",
  "t3_environment_read",
  "t3_worktree_list",
]);

/**
 * Scopes the hub holds on each T3 server and hands on to phones. Everything a
 * client normally gets except `environment:maintain` (no remote updates) and
 * the T3 Connect relay scopes. The installer requests the same list.
 */
export const HUB_SCOPES = [
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "preview:operate",
  "diagnostics:read",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "filesystem:read",
  "filesystem:write",
  "access:read",
  "access:write",
] as const;

/** `t3_thread_wait` blocks server-side; give it room beyond its own timeout. */
const LONG_CALL_MS = 15 * 60_000;

export interface FleetThread {
  serverId: string;
  projectId: string;
  projectTitle: string | null;
  threadId: string;
  title: string | null;
  status: string | null;
  updatedAt: string | null;
  raw: unknown;
}

export interface FleetPending {
  serverId: string;
  threadId: string;
  threadTitle: string | null;
  requestId: string;
  summary: string;
  raw: unknown;
}

export interface ServerOverview {
  serverId: string;
  ok: boolean;
  error: string | null;
  environment: unknown;
  projects: Array<{ projectId: string; title: string | null; raw: unknown }>;
  threads: FleetThread[];
  pending: FleetPending[];
  fetchedAt: string;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const pickString = (record: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
};

export class ToolCallError extends Error {
  readonly value: unknown;
  constructor(message: string, value: unknown) {
    super(message);
    this.value = value;
  }
}

export class Fleet {
  private readonly db: HubDb;
  private readonly fetchImpl: typeof fetch;
  private readonly clients = new Map<string, { link: Link; client: McpClient }>();
  private toolCatalog: { tools: McpTool[]; at: number } | null = null;
  private readonly overviews = new Map<string, ServerOverview>();

  constructor(db: HubDb, fetchImpl: typeof fetch = fetch) {
    this.db = db;
    this.fetchImpl = fetchImpl;
  }

  client(serverId: string): McpClient {
    const link = this.db.getLink(serverId);
    if (!link) throw new Error(`Server '${serverId}' is not linked to the hub.`);
    const cached = this.clients.get(serverId);
    if (cached && cached.link.mcpToken === link.mcpToken && cached.link.t3Url === link.t3Url) {
      return cached.client;
    }
    const client = new McpClient(new URL("/mcp", link.t3Url).href, link.mcpToken, this.fetchImpl);
    this.clients.set(serverId, { link, client });
    return client;
  }

  forget(serverId: string) {
    this.clients.delete(serverId);
    this.overviews.delete(serverId);
  }

  /** Calls a T3 tool on one server and returns its value, or throws with the server's message. */
  async call(serverId: string, tool: string, args: Record<string, unknown> = {}) {
    const result = await this.callRaw(serverId, tool, args);
    const value = toolResultValue(result);
    if (result.isError) {
      const message =
        pickString(asRecord(value), "message") ?? (typeof value === "string" ? value : tool);
      throw new ToolCallError(message, value);
    }
    return value;
  }

  async callRaw(
    serverId: string,
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    try {
      const result = await this.client(serverId).callTool(
        tool,
        args,
        tool === "t3_thread_wait" ? LONG_CALL_MS : undefined,
      );
      this.db.markLink(serverId, null);
      return result;
    } catch (error) {
      this.db.markLink(serverId, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  /** The proxied tool catalog, read from the first reachable linked server. */
  async proxiedTools(): Promise<McpTool[]> {
    if (this.toolCatalog && Date.now() - this.toolCatalog.at < 10 * 60_000) {
      return this.toolCatalog.tools;
    }
    for (const link of this.db.listLinks()) {
      try {
        const tools = (await this.client(link.serverId).listTools()).filter((tool) =>
          PROXIED_TOOLS.has(tool.name),
        );
        this.toolCatalog = { tools, at: Date.now() };
        return tools;
      } catch {
        continue;
      }
    }
    return this.toolCatalog?.tools ?? [];
  }

  async verifyLink(serverId: string) {
    const environment = await this.call(serverId, "t3_environment_read");
    return asRecord(environment);
  }

  /** Mints a one-time pairing link on a linked server, for a phone to connect to it directly. */
  async mintPairingLink(serverId: string, label: string) {
    const link = this.db.getLink(serverId);
    if (!link) throw new Error(`Server '${serverId}' is not linked to the hub.`);
    const response = await this.fetchImpl(new URL("/api/auth/pairing-token", link.t3Url), {
      method: "POST",
      headers: { authorization: `Bearer ${link.bearerToken}`, "content-type": "application/json" },
      body: JSON.stringify({ label, scopes: HUB_SCOPES }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (!response.ok)
      throw new Error(
        `Pairing token request failed: HTTP ${response.status} ${text.slice(0, 200)}`,
      );
    const body = asRecord(JSON.parse(text));
    const credential = pickString(body, "credential", "token");
    if (!credential) throw new Error("Pairing token response had no credential.");
    const base = link.t3Url.replace(/\/+$/, "");
    return {
      serverId,
      url: base,
      credential,
      pairingUrl: `${base}/pair#token=${encodeURIComponent(credential)}`,
      expiresAt: pickString(body, "expiresAt"),
    };
  }

  async overview(serverId: string): Promise<ServerOverview> {
    const fetchedAt = new Date().toISOString();
    try {
      const environment = await this.call(serverId, "t3_environment_read");
      const projectList = asRecord(await this.call(serverId, "t3_project_list", { limit: 100 }));
      const projects = asArray(projectList.projects).map((raw) => {
        const record = asRecord(raw);
        return {
          projectId: pickString(record, "projectId", "id") ?? "",
          title: pickString(record, "title", "name"),
          raw,
        };
      });
      const threads: FleetThread[] = [];
      for (const project of projects) {
        if (!project.projectId) continue;
        const list = asRecord(
          await this.call(serverId, "t3_thread_list", { projectId: project.projectId }),
        );
        for (const raw of asArray(list.threads)) {
          const record = asRecord(raw);
          threads.push({
            serverId,
            projectId: project.projectId,
            projectTitle: project.title,
            threadId: pickString(record, "threadId", "id") ?? "",
            title: pickString(record, "title"),
            status: pickString(record, "status"),
            updatedAt: pickString(record, "updatedAt", "lastActivityAt"),
            raw,
          });
        }
      }
      const pending: FleetPending[] = [];
      const waiting = threads.filter((candidate) => {
        const count = asRecord(candidate.raw).pendingRequestCount;
        return candidate.status === "waiting" || (typeof count === "number" && count > 0);
      });
      for (const thread of waiting) {
        const list = asRecord(
          await this.call(serverId, "t3_pending_request", {
            action: "list",
            threadId: thread.threadId,
          }),
        );
        for (const raw of asArray(list.requests ?? list.pendingRequests ?? list.items)) {
          const record = asRecord(raw);
          pending.push({
            serverId,
            threadId: thread.threadId,
            threadTitle: thread.title,
            requestId: pickString(record, "requestId", "id") ?? "",
            summary:
              pickString(record, "summary", "title", "question", "kind", "type") ??
              "Waiting for a response",
            raw,
          });
        }
      }
      const overview = {
        serverId,
        ok: true,
        error: null,
        environment,
        projects,
        threads,
        pending,
        fetchedAt,
      };
      this.overviews.set(serverId, overview);
      return overview;
    } catch (error) {
      const overview: ServerOverview = {
        serverId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        environment: null,
        projects: [],
        threads: [],
        pending: [],
        fetchedAt,
      };
      this.overviews.set(serverId, overview);
      return overview;
    }
  }

  async overviewAll(): Promise<ServerOverview[]> {
    return Promise.all(this.db.listLinks().map((link) => this.overview(link.serverId)));
  }

  lastOverview(serverId: string) {
    return this.overviews.get(serverId) ?? null;
  }

  describeServers() {
    const links = new Map(this.db.listLinks().map((link) => [link.serverId, link]));
    const services = this.db.listServices();
    return this.db.listServers().map((server) => {
      const link = links.get(server.id);
      return {
        ...server,
        ssh: sshTarget(server),
        t3: link
          ? { url: link.t3Url, linked: true, lastOkAt: link.lastOkAt, lastError: link.lastError }
          : { url: server.t3Url, linked: false, lastOkAt: null, lastError: null },
        serviceCount: services.filter((service) => service.serverId === server.id).length,
      };
    });
  }

  findServices(query: string) {
    const needle = query.toLowerCase().trim();
    const servers = new Map(this.db.listServers().map((server) => [server.id, server]));
    const terms = needle.split(/\s+/).filter(Boolean);
    return this.db
      .listServices()
      .filter((service) => {
        const haystack = [service.name, service.image, service.composeDir, ...service.configFiles]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .map((service) => {
        const server = servers.get(service.serverId);
        return {
          ...service,
          server: server
            ? { id: server.id, ssh: sshTarget(server), keyName: server.keyName, tags: server.tags }
            : null,
          updateHint: updateHint(service),
        };
      });
  }
}

export function sshTarget(server: Pick<RegistryServer, "address" | "user" | "port">) {
  const host = server.user ? `${server.user}@${server.address}` : server.address;
  return server.port === 22 ? `ssh ${host}` : `ssh -p ${server.port} ${host}`;
}

export function updateHint(service: RegistryService): string {
  switch (service.kind) {
    case "docker":
      return service.composeDir
        ? `cd ${service.composeDir} && docker compose pull && docker compose up -d`
        : `Standalone container from ${service.image ?? "an unknown image"}: pull the new image, then recreate it with the same options (docker inspect ${service.name}).`;
    case "systemd":
      return `Update the package or binary behind the unit, then sudo systemctl restart ${service.name}${
        service.configFiles[0] ? ` (unit: ${service.configFiles[0]})` : ""
      }`;
    case "brew":
      return `brew upgrade ${service.name} && brew services restart ${service.name}`;
    case "launchd":
      return `Update the program in ${service.configFiles[0] ?? "the plist"}, then launchctl kickstart -k the job ${service.name}`;
  }
}
