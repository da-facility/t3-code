import * as NodeHttp from "node:http";

import type { Device, MetaserverDb } from "./db.ts";
import { type Fleet, PROXIED_TOOLS, ToolCallError } from "./fleet.ts";
import { handleFleetMcp } from "./fleetMcp.ts";
import { rpIdAllowed } from "./vault/passkeys.ts";
import type { PushFn } from "./watcher.ts";

/**
 * The metaserver's HTTP surface, reachable only over Tailscale:
 *   /mcp   fleet MCP for agents (fleet token)
 *   /api/* the Scope app (device token)
 */

export interface MetaserverHttpOptions {
  db: MetaserverDb;
  fleet: Fleet;
  push: PushFn | null;
  /** Extra routes (the vault) mounted under /api. Returns false when it did not handle the request. */
  extraRoutes?: (context: RouteContext) => Promise<boolean>;
  /** Answers a credential request from a fleet host (the browser fill); null when refused. */
  requestCredential?: (
    url: string,
    requester: string,
  ) => Promise<{ username: string | null; password: string | null; title: string } | null>;
  onDeviceRevoked?: (deviceId: string) => void;
  /** WebAuthn for the server browser, approved on the phone; null when refused. */
  passkeys?: {
    create: (input: {
      origin: string;
      rpId: string;
      challenge: string;
      user: { id: string; name: string; displayName?: string };
      requester: string;
    }) => Promise<unknown>;
    get: (input: {
      origin: string;
      rpId: string;
      challenge: string;
      allowCredentials: string[];
      requester: string;
    }) => Promise<unknown>;
  };
  /** Loopback-only operator routes for the metaserver CLI (vault lock, test requests). */
  adminRoutes?: (path: string, body: unknown) => Promise<unknown>;
}

export interface RouteContext {
  method: string;
  path: string;
  url: URL;
  device: Device | null;
  body: () => Promise<unknown>;
  send: (status: number, body: unknown, headers?: Record<string, string>) => void;
}

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MAX_BODY = 1024 * 1024;

function readBody(request: NodeHttp.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, "Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, "Invalid JSON"));
      }
    });
    request.on("error", reject);
  });
}

const bearer = (request: NodeHttp.IncomingMessage) => {
  const header = request.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1]!.trim() : null;
};

const publicDevice = (device: Device) => ({
  id: device.id,
  name: device.name,
  role: device.role,
  status: device.status,
  hasPush: device.apnsToken !== null,
  createdAt: device.createdAt,
  approvedAt: device.approvedAt,
  lastSeenAt: device.lastSeenAt,
});

export function createMetaserverHttpServer(options: MetaserverHttpOptions) {
  const { db, fleet } = options;

  const requireApproved = (device: Device | null) => {
    if (!device) throw new HttpError(401, "Enroll this device first.");
    if (device.status === "pending")
      throw new HttpError(403, "Waiting for approval from an enrolled device.");
    if (device.status !== "approved") throw new HttpError(403, "This device was revoked.");
    return device;
  };

  const handleApi = async (context: RouteContext) => {
    const { method, path, device, send } = context;
    const segments = path.split("/").filter(Boolean).slice(1);

    if (method === "POST" && path === "/api/enroll") {
      const body = (await context.body()) as { name?: unknown; publicKey?: unknown };
      const name =
        typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "Phone";
      const publicKey = typeof body.publicKey === "string" ? body.publicKey : null;
      const { device: enrolled, token } = db.enrollDevice(name, publicKey);
      return send(200, { device: publicDevice(enrolled), token });
    }

    if (method === "GET" && path === "/api/me") {
      if (!device) throw new HttpError(401, "Unknown device token.");
      return send(200, { device: publicDevice(device) });
    }

    const me = requireApproved(device);

    if (options.extraRoutes && (await options.extraRoutes(context))) return;

    if (method === "GET" && path === "/api/devices") {
      return send(200, { devices: db.listDevices().map(publicDevice) });
    }
    if (method === "POST" && segments[0] === "devices" && segments[2] === "approve") {
      if (!db.approveDevice(segments[1]!, me.id))
        throw new HttpError(404, "No pending device with that id.");
      return send(200, { device: publicDevice(db.getDevice(segments[1]!)!) });
    }
    if (method === "POST" && segments[0] === "devices" && segments[2] === "revoke") {
      const target = db.getDevice(segments[1]!);
      if (!target) throw new HttpError(404, "No device with that id.");
      if (target.role === "owner" && me.role !== "owner")
        throw new HttpError(403, "Only the owner can revoke the owner.");
      db.revokeDevice(target.id);
      options.onDeviceRevoked?.(target.id);
      return send(200, { device: publicDevice(db.getDevice(target.id)!) });
    }

    if (method === "GET" && path === "/api/servers") {
      return send(200, { servers: fleet.describeServers() });
    }
    if (method === "GET" && segments[0] === "servers" && segments.length === 2) {
      const server = fleet.describeServers().find((candidate) => candidate.id === segments[1]);
      if (!server) throw new HttpError(404, "Unknown server.");
      return send(200, { server, services: db.listServices(server.id) });
    }
    if (method === "GET" && path === "/api/services") {
      return send(200, { services: fleet.findServices(context.url.searchParams.get("q") ?? "") });
    }
    if (method === "GET" && path === "/api/overview") {
      const refresh = context.url.searchParams.get("refresh") === "1";
      const overviews = await Promise.all(
        db
          .listLinks()
          .map(
            (link) =>
              (!refresh && fleet.lastOverview(link.serverId)) || fleet.overview(link.serverId),
          ),
      );
      return send(200, { servers: overviews });
    }
    if (method === "POST" && segments[0] === "servers" && segments[2] === "pairing") {
      return send(200, await fleet.mintPairingLink(segments[1]!, `Scope: ${me.name}`));
    }
    if (method === "POST" && segments[0] === "servers" && segments[2] === "call") {
      const body = (await context.body()) as { tool?: unknown; arguments?: unknown };
      const tool = String(body.tool ?? "");
      if (!PROXIED_TOOLS.has(tool))
        throw new HttpError(400, `Tool '${tool}' is not available through the metaserver.`);
      try {
        const value = await fleet.call(
          segments[1]!,
          tool,
          (body.arguments ?? {}) as Record<string, unknown>,
        );
        return send(200, { value });
      } catch (error) {
        if (error instanceof ToolCallError)
          return send(422, { error: error.message, value: error.value });
        throw error;
      }
    }
    if (method === "POST" && path === "/api/push") {
      const body = (await context.body()) as { token?: unknown; environment?: unknown };
      const token =
        typeof body.token === "string" && /^[0-9a-fA-F]{32,200}$/.test(body.token)
          ? body.token
          : null;
      const environment = body.environment === "production" ? "production" : "sandbox";
      db.setPushToken(me.id, token, token ? environment : null);
      return send(200, { ok: true });
    }
    if (method === "POST" && path === "/api/push/test") {
      if (!options.push) throw new HttpError(503, "Push is not configured on the metaserver.");
      const fresh = db.getDevice(me.id)!;
      if (!fresh.apnsToken) throw new HttpError(400, "This device has not registered for push.");
      const result = await options.push(fresh.apnsToken, fresh.apnsEnv, {
        title: "Scope",
        body: "Push notifications from the metaserver work.",
        timeSensitive: true,
      });
      return send(result.ok ? 200 : 502, result);
    }
    throw new HttpError(404, "Not found");
  };

  return NodeHttp.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://metaserver");
    const method = request.method ?? "GET";
    const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      if (response.headersSent) return;
      if (body === null) {
        response.writeHead(status, headers).end();
        return;
      }
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      });
      response.end(JSON.stringify(body));
    };
    try {
      if (url.pathname === "/healthz") return send(200, { ok: true });

      if (url.pathname === "/mcp") {
        const token = bearer(request);
        if (!token || !db.verifyToken(token)) {
          return send(
            401,
            { error: "A fleet token is required." },
            { "www-authenticate": "Bearer" },
          );
        }
        if (method === "GET")
          return send(405, { error: "This server does not stream." }, { allow: "POST, DELETE" });
        if (method === "DELETE") return send(200, {});
        if (method !== "POST") return send(405, { error: "Method not allowed" });
        const result = await handleFleetMcp(fleet, await readBody(request));
        return send(result.status, result.body, result.headers);
      }

      if (url.pathname.startsWith("/admin/") && method === "POST") {
        const remote = request.socket.remoteAddress ?? "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) || !options.adminRoutes) {
          return send(404, { error: "Not found" });
        }
        return send(200, await options.adminRoutes(url.pathname, await readBody(request)));
      }

      if (
        (url.pathname === "/passkeys/create" || url.pathname === "/passkeys/get") &&
        method === "POST"
      ) {
        const token = bearer(request);
        const caller = token ? db.verifyToken(token) : null;
        if (!caller) return send(401, { error: "A fleet token is required." });
        if (!options.passkeys) return send(503, { error: "The vault is not available." });
        const body = (await readBody(request)) as {
          origin?: unknown;
          rpId?: unknown;
          challenge?: unknown;
          user?: { id?: unknown; name?: unknown; displayName?: unknown };
          allowCredentials?: unknown;
        };
        if (typeof body.origin !== "string" || typeof body.challenge !== "string") {
          return send(400, { error: "Expected origin and challenge." });
        }
        const origin = body.origin;
        const rpId =
          typeof body.rpId === "string" && body.rpId ? body.rpId : new URL(origin).hostname;
        if (!rpIdAllowed(rpId, origin))
          return send(403, { error: "The relying party does not match the page." });
        const requester = caller.serverId ?? caller.label;
        const result =
          url.pathname === "/passkeys/create"
            ? typeof body.user?.id === "string" && typeof body.user.name === "string"
              ? await options.passkeys.create({
                  origin,
                  rpId,
                  challenge: body.challenge,
                  user: {
                    id: body.user.id,
                    name: body.user.name,
                    ...(typeof body.user.displayName === "string"
                      ? { displayName: body.user.displayName }
                      : {}),
                  },
                  requester,
                })
              : undefined
            : await options.passkeys.get({
                origin,
                rpId,
                challenge: body.challenge,
                allowCredentials: Array.isArray(body.allowCredentials)
                  ? body.allowCredentials.filter((id): id is string => typeof id === "string")
                  : [],
                requester,
              });
        if (result === undefined) return send(400, { error: "Expected user.id and user.name." });
        return result ? send(200, result) : send(403, { error: "Not approved on the phone." });
      }

      if (url.pathname === "/credentials" && method === "POST") {
        const token = bearer(request);
        const caller = token ? db.verifyToken(token) : null;
        if (!caller) return send(401, { error: "A fleet token is required." });
        if (!options.requestCredential) return send(503, { error: "The vault is not available." });
        const body = (await readBody(request)) as { url?: unknown };
        if (typeof body.url !== "string") return send(400, { error: "Expected url." });
        const credential = await options.requestCredential(
          body.url,
          caller.serverId ?? caller.label,
        );
        return credential
          ? send(200, credential)
          : send(403, { error: "Not approved on the phone." });
      }

      if (url.pathname.startsWith("/api/")) {
        const token = bearer(request);
        const device = token ? db.deviceByToken(token) : null;
        let parsed: Promise<unknown> | null = null;
        await handleApi({
          method,
          path: url.pathname.replace(/\/+$/, ""),
          url,
          device,
          body: () => (parsed ??= readBody(request)),
          send,
        });
        return;
      }
      send(404, { error: "Not found" });
    } catch (error) {
      if (error instanceof HttpError) return send(error.status, { error: error.message });
      send(500, { error: error instanceof Error ? error.message : "Internal error" });
    }
  });
}
