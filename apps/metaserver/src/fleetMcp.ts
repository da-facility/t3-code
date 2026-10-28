import * as NodeCrypto from "node:crypto";

import { type Fleet, ToolCallError } from "./fleet.ts";
import type { McpTool } from "./t3Client.ts";

/**
 * The fleet MCP: one endpoint every agent on every T3 host can call. It lists
 * servers and services from the registry and proxies a T3 server's own tools,
 * renamed `t3_*` -> `fleet_*` with a required `server` argument.
 */

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const SERVER_ARG = {
  type: "string",
  description: "Fleet server id from fleet_servers_list.",
};

const FLEET_TOOLS: McpTool[] = [
  {
    name: "fleet_servers_list",
    description:
      "List every machine in the fleet registry: SSH target, tags, whether a T3 server runs there and is linked, and scan status. Connect to a machine with your own host's SSH key.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fleet_server_info",
    description:
      "One machine's registry entry and the services found on it (docker, systemd, brew, launchd).",
    inputSchema: {
      type: "object",
      properties: { server: SERVER_ARG },
      required: ["server"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fleet_service_find",
    description:
      "Find where a service runs, e.g. 'rustdesk'. Matches service names, images, compose directories and config files across every scanned machine, with the SSH target and how to update it.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Words that must all match." } },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "fleet_overview",
    description:
      "Projects, threads and pending requests across every linked T3 server (or one). Use it to find a server and project before fleet_thread_launch or fleet_thread_send.",
    inputSchema: {
      type: "object",
      properties: { server: { ...SERVER_ARG, description: "Limit to one server." } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const proxiedName = (t3Name: string) => t3Name.replace(/^t3_/, "fleet_");

export function proxiedTool(tool: McpTool): McpTool {
  const schema = (tool.inputSchema ?? { type: "object", properties: {} }) as {
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
  return {
    name: proxiedName(tool.name),
    description: `On a fleet server: ${tool.description ?? tool.name}`,
    inputSchema: {
      ...schema,
      properties: { server: SERVER_ARG, ...schema.properties },
      required: ["server", ...(schema.required ?? [])],
    },
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}

const textResult = (value: unknown, isError = false) => ({
  content: [
    { type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
  ],
  ...(value !== null && typeof value === "object" && !Array.isArray(value)
    ? { structuredContent: value }
    : {}),
  ...(isError ? { isError: true } : {}),
});

function compactOverview(overview: Awaited<ReturnType<Fleet["overview"]>>) {
  return {
    server: overview.serverId,
    ok: overview.ok,
    ...(overview.error ? { error: overview.error } : {}),
    projects: overview.projects.map((project) => ({
      projectId: project.projectId,
      title: project.title,
    })),
    threads: overview.threads.map((thread) => ({
      threadId: thread.threadId,
      projectId: thread.projectId,
      title: thread.title,
      status: thread.status,
      updatedAt: thread.updatedAt,
    })),
    pending: overview.pending.map((request) => ({
      threadId: request.threadId,
      requestId: request.requestId,
      summary: request.summary,
    })),
  };
}

export async function callFleetTool(fleet: Fleet, name: string, args: Record<string, unknown>) {
  switch (name) {
    case "fleet_servers_list":
      return textResult({ servers: fleet.describeServers() });
    case "fleet_server_info": {
      const server = fleet.describeServers().find((candidate) => candidate.id === args.server);
      if (!server) return textResult(`Unknown server '${String(args.server)}'.`, true);
      return textResult({
        server,
        services: fleet.findServices("").filter((s) => s.serverId === server.id),
      });
    }
    case "fleet_service_find":
      return textResult({ services: fleet.findServices(String(args.query ?? "")) });
    case "fleet_overview": {
      const overviews =
        typeof args.server === "string"
          ? [await fleet.overview(args.server)]
          : await fleet.overviewAll();
      return textResult({ servers: overviews.map(compactOverview) });
    }
  }
  if (!name.startsWith("fleet_")) return textResult(`Unknown tool '${name}'.`, true);
  const t3Name = `t3_${name.slice("fleet_".length)}`;
  const { server, ...rest } = args;
  if (typeof server !== "string")
    return textResult("Pass `server` (see fleet_servers_list).", true);
  try {
    return await fleet.callRaw(server, t3Name, rest);
  } catch (error) {
    if (error instanceof ToolCallError) return textResult(error.value, true);
    return textResult(`${server}: ${error instanceof Error ? error.message : String(error)}`, true);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export async function handleFleetMcp(
  fleet: Fleet,
  body: unknown,
): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
  const messages = Array.isArray(body) ? (body as JsonRpcRequest[]) : [body as JsonRpcRequest];
  const headers: Record<string, string> = {};
  const responses: unknown[] = [];
  for (const message of messages) {
    if (!message || typeof message.method !== "string") {
      responses.push({
        jsonrpc: "2.0",
        id: message?.id ?? null,
        error: { code: -32600, message: "Invalid request" },
      });
      continue;
    }
    const isNotification = message.id === undefined || message.id === null;
    const reply = (result: unknown) => {
      if (!isNotification) responses.push({ jsonrpc: "2.0", id: message.id, result });
    };
    const fail = (code: number, text: string) => {
      if (!isNotification)
        responses.push({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
    };
    switch (message.method) {
      case "initialize": {
        const requested = String(message.params?.protocolVersion ?? "");
        headers["mcp-session-id"] = NodeCrypto.randomUUID();
        reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "fleet", version: "1" },
          instructions:
            "Fleet tools from the t3 metaserver. fleet_servers_list and fleet_service_find answer 'where does X run'; connect with your own SSH key. fleet_overview, then fleet_thread_launch / fleet_thread_send and fleet_thread_wait run work on another T3 server and return its result.",
        });
        break;
      }
      case "ping":
        reply({});
        break;
      case "tools/list": {
        const proxied = (await fleet.proxiedTools()).map(proxiedTool);
        reply({ tools: [...FLEET_TOOLS, ...proxied] });
        break;
      }
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
        try {
          reply(await callFleetTool(fleet, name, args));
        } catch (error) {
          reply(textResult(error instanceof Error ? error.message : String(error), true));
        }
        break;
      }
      default:
        if (message.method.startsWith("notifications/")) break;
        fail(-32601, `Method not found: ${message.method}`);
    }
  }
  if (responses.length === 0) return { status: 202, headers, body: null };
  return { status: 200, headers, body: Array.isArray(body) ? responses : responses[0] };
}
