import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import type { PushMessage } from "./apns.ts";
import { HubDb } from "./db.ts";
import { Fleet, HUB_SCOPES } from "./fleet.ts";
import { createHubServer } from "./http.ts";
import { McpClient, toolResultValue } from "./mcpClient.ts";
import { startFakeT3 } from "./testing/fakeT3.ts";
import { Watcher } from "./watcher.ts";

async function setup() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fleet-hub-test-"));
  const db = new HubDb(NodePath.join(dir, "hub.sqlite"));
  const t3 = await startFakeT3("mcp-token", "bearer-token");
  db.upsertServer({
    id: "host-a",
    address: "host-a.example.ts.net",
    user: "deploy",
    sources: ["manual"],
  });
  db.setLink("host-a", t3.url, "bearer-token", "mcp-token");
  const fleet = new Fleet(db);
  const server = createHubServer({ db, fleet, push: null });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  return {
    db,
    fleet,
    t3,
    base,
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await t3.close();
      db.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const api = (base: string, path: string, token: string | null, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));

describe("fleet hub", () => {
  it("makes the first device the owner and gates later ones on approval", async () => {
    await using hub = await setup();
    const owner = await api(hub.base, "/api/enroll", null, { name: "phone" });
    expect(owner.body.device).toMatchObject({ role: "owner", status: "approved" });

    const second = await api(hub.base, "/api/enroll", null, { name: "tablet" });
    expect(second.body.device).toMatchObject({ role: "member", status: "pending" });
    expect((await api(hub.base, "/api/servers", second.body.token)).status).toBe(403);

    const approved = await api(
      hub.base,
      `/api/devices/${second.body.device.id}/approve`,
      owner.body.token,
      {},
    );
    expect(approved.body.device.status).toBe("approved");
    expect((await api(hub.base, "/api/servers", second.body.token)).status).toBe(200);

    expect(
      (await api(hub.base, `/api/devices/${owner.body.device.id}/revoke`, second.body.token, {}))
        .status,
    ).toBe(403);
    await api(hub.base, `/api/devices/${second.body.device.id}/revoke`, owner.body.token, {});
    expect((await api(hub.base, "/api/servers", second.body.token)).status).toBe(403);
    expect((await api(hub.base, "/api/servers", "nonsense")).status).toBe(401);
  });

  it("mints phone pairing links with the hub's scopes, never environment:maintain", async () => {
    await using hub = await setup();
    const { token } = (await api(hub.base, "/api/enroll", null, { name: "phone" })).body;
    const pairing = await api(hub.base, "/api/servers/host-a/pairing", token, {});
    expect(pairing.body.pairingUrl).toBe(`${hub.t3.url}/pair#token=PAIRCODE`);
    expect(hub.t3.pairingRequests).toEqual([{ label: "Scope: phone", scopes: [...HUB_SCOPES] }]);
    expect(HUB_SCOPES).not.toContain("environment:maintain");
  });

  it("serves the fleet MCP: fleet tools plus proxied T3 tools that route by server", async () => {
    await using hub = await setup();
    const unauthorized = await fetch(`${hub.base}/mcp`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const { token } = hub.db.issueToken("agent", "host-a");
    const client = new McpClient(`${hub.base}/mcp`, token);
    const names = (await client.listTools()).map((tool) => tool.name);
    expect(names).toContain("fleet_servers_list");
    expect(names).toContain("fleet_thread_launch");
    // Tools that need a calling thread are not re-exported.
    expect(names).not.toContain("fleet_delegate_task");
    expect(names).not.toContain("delegate_task");

    const launchSchema = (await client.listTools()).find(
      (tool) => tool.name === "fleet_thread_launch",
    )!;
    expect((launchSchema.inputSchema as { required: string[] }).required).toContain("server");

    const launched = toolResultValue(
      await client.callTool("fleet_thread_launch", {
        server: "host-a",
        projectId: "p1",
        title: "Hi",
        message: "x",
      }),
    );
    expect(launched).toMatchObject({ threadId: "t-new" });
    expect(hub.t3.calls.at(-1)).toEqual({
      tool: "t3_thread_launch",
      args: { projectId: "p1", title: "Hi", message: "x" },
    });

    const servers = toolResultValue(await client.callTool("fleet_servers_list", {})) as any;
    expect(servers.servers[0]).toMatchObject({
      id: "host-a",
      ssh: "ssh deploy@host-a.example.ts.net",
      t3: { linked: true },
    });

    const missing = await client.callTool("fleet_thread_list", { server: "nowhere" });
    expect(missing.isError).toBe(true);
  });

  it("finds services with SSH targets and update hints", async () => {
    await using hub = await setup();
    hub.db.replaceServices(
      "host-a",
      [
        {
          serverId: "host-a",
          kind: "docker",
          name: "rustdesk-hbbs",
          status: "running",
          image: "rustdesk/rustdesk-server:1",
          composeDir: "/opt/rustdesk",
          configFiles: ["/opt/rustdesk/compose.yaml"],
          scannedAt: "2026-01-01T00:00:00Z",
        },
      ],
      null,
    );
    const [found] = hub.fleet.findServices("RustDesk");
    expect(found).toMatchObject({
      server: { id: "host-a", ssh: "ssh deploy@host-a.example.ts.net" },
      updateHint: "cd /opt/rustdesk && docker compose pull && docker compose up -d",
    });
    expect(hub.fleet.findServices("nginx")).toEqual([]);
  });

  it("pushes new pending requests and finished turns, but not on the first poll", async () => {
    await using hub = await setup();
    hub.db.enrollDevice("phone", null);
    const device = hub.db.listDevices()[0]!;
    hub.db.setPushToken(device.id, "a".repeat(64), "sandbox");
    const sent: PushMessage[] = [];
    const watcher = new Watcher(hub.db, hub.fleet, async (_token, _env, message) => {
      sent.push(message);
      return { ok: true };
    });

    hub.t3.state.threads = [
      { threadId: "t1", title: "Old", status: "waiting", pendingRequestCount: 1 },
    ];
    hub.t3.state.pending = [{ requestId: "r-old", summary: "old request" }];
    await watcher.poll();
    expect(sent).toEqual([]);

    hub.t3.state.threads = [
      { threadId: "t1", title: "Old", status: "waiting", pendingRequestCount: 2 },
      { threadId: "t2", title: "Build", status: "running", pendingRequestCount: 0 },
    ];
    hub.t3.state.pending = [
      { requestId: "r-old", summary: "old request" },
      { requestId: "r-new", summary: "Run rm -rf build?" },
    ];
    await watcher.poll();
    expect(sent).toEqual([
      {
        title: "host-a: needs you",
        body: "Old: Run rm -rf build?",
        timeSensitive: true,
        data: { kind: "pending", serverId: "host-a", threadId: "t1", requestId: "r-new" },
      },
    ]);

    hub.t3.state.threads = [
      { threadId: "t2", title: "Build", status: "completed", pendingRequestCount: 0 },
    ];
    hub.t3.state.pending = [];
    await watcher.poll();
    expect(sent.at(-1)).toEqual({
      title: "host-a: done",
      body: "Build",
      data: { kind: "turn", serverId: "host-a", threadId: "t2" },
    });
  });
});
