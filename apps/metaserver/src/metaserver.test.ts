import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import type { PushMessage } from "./apns.ts";
import { MetaserverDb } from "./db.ts";
import { Fleet, METASERVER_SCOPES } from "./fleet.ts";
import { createMetaserverHttpServer } from "./http.ts";
import { renderRelayCaddy, syncRelay } from "./relay.ts";
import { T3Client, toolResultValue } from "./t3Client.ts";
import { startFakeT3 } from "./testing/fakeT3.ts";
import { Watcher } from "./watcher.ts";

async function setup(publicHost: string | null = null) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-metaserver-test-"));
  const db = new MetaserverDb(NodePath.join(dir, "metaserver.sqlite"));
  const t3 = await startFakeT3("mcp-token", "bearer-token");
  db.upsertServer({
    id: "host-a",
    address: "host-a.example.ts.net",
    user: "deploy",
    sources: ["manual"],
  });
  db.setLink("host-a", t3.url, "bearer-token", "mcp-token");
  const fleet = new Fleet(db, fetch, publicHost);
  const server = createMetaserverHttpServer({ db, fleet, push: null });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}`;
  return {
    dir,
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

const link = (db: MetaserverDb, id: string, url: string) => {
  db.upsertServer({ id, address: `${id}.example.ts.net`, sources: ["manual"] });
  db.setLink(id, url, "bearer", "mcp");
};

const api = (base: string, path: string, token: string | null, body?: unknown) =>
  fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (response) => ({ status: response.status, body: (await response.json()) as any }));

describe("t3 metaserver", () => {
  it("makes the first device the owner and gates later ones on approval", async () => {
    await using metaserver = await setup();
    const owner = await api(metaserver.base, "/api/enroll", null, { name: "phone" });
    expect(owner.body.device).toMatchObject({ role: "owner", status: "approved" });

    const second = await api(metaserver.base, "/api/enroll", null, { name: "tablet" });
    expect(second.body.device).toMatchObject({ role: "member", status: "pending" });
    expect((await api(metaserver.base, "/api/servers", second.body.token)).status).toBe(403);

    const approved = await api(
      metaserver.base,
      `/api/devices/${second.body.device.id}/approve`,
      owner.body.token,
      {},
    );
    expect(approved.body.device.status).toBe("approved");
    expect((await api(metaserver.base, "/api/servers", second.body.token)).status).toBe(200);

    expect(
      (
        await api(
          metaserver.base,
          `/api/devices/${owner.body.device.id}/revoke`,
          second.body.token,
          {},
        )
      ).status,
    ).toBe(403);
    await api(
      metaserver.base,
      `/api/devices/${second.body.device.id}/revoke`,
      owner.body.token,
      {},
    );
    expect((await api(metaserver.base, "/api/servers", second.body.token)).status).toBe(403);
    expect((await api(metaserver.base, "/api/servers", "nonsense")).status).toBe(401);
  });

  it("mints phone pairing links with the metaserver's scopes, never environment:maintain", async () => {
    await using metaserver = await setup();
    const { token } = (await api(metaserver.base, "/api/enroll", null, { name: "phone" })).body;
    const pairing = await api(metaserver.base, "/api/servers/host-a/pairing", token, {});
    expect(pairing.body.pairingUrl).toBe(`${metaserver.t3.url}/pair#token=PAIRCODE`);
    expect(metaserver.t3.pairingRequests).toEqual([
      { label: "Scope: phone", scopes: [...METASERVER_SCOPES] },
    ]);
    expect(METASERVER_SCOPES).not.toContain("environment:maintain");
  });

  it("pairs phones through the relay when the metaserver has a public host", async () => {
    await using metaserver = await setup("metaserver.example.ts.net");
    metaserver.db.assignRelayPorts(9001);
    const { token } = (await api(metaserver.base, "/api/enroll", null, { name: "phone" })).body;
    const pairing = await api(metaserver.base, "/api/servers/host-a/pairing", token, {});
    expect(pairing.body).toMatchObject({
      url: "https://metaserver.example.ts.net:9001",
      pairingUrl: "https://metaserver.example.ts.net:9001/pair#token=PAIRCODE",
    });
    // The token itself still comes from the t3 server, with the stored bearer.
    expect(metaserver.t3.pairingRequests).toHaveLength(1);
    const servers = await api(metaserver.base, "/api/servers", token);
    expect(servers.body.servers[0].relayUrl).toBe("https://metaserver.example.ts.net:9001");
  });

  it("has no relay URL without a public host", async () => {
    await using metaserver = await setup();
    metaserver.db.assignRelayPorts(9001);
    const { token } = (await api(metaserver.base, "/api/enroll", null, { name: "phone" })).body;
    const servers = await api(metaserver.base, "/api/servers", token);
    expect(servers.body.servers[0].relayUrl).toBeNull();
    const pairing = await api(metaserver.base, "/api/servers/host-a/pairing", token, {});
    expect(pairing.body.url).toBe(metaserver.t3.url);
  });

  it("keeps a server's relay port across re-links and frees it on unlink", async () => {
    await using metaserver = await setup();
    const { db } = metaserver;
    link(db, "host-b", "http://host-b:3773");
    link(db, "host-c", "https://host-c.example.ts.net");
    db.assignRelayPorts(9001);
    const ports = () => Object.fromEntries(db.listLinks().map((l) => [l.serverId, l.relayPort]));
    expect(ports()).toEqual({ "host-a": 9001, "host-b": 9002, "host-c": 9003 });

    link(db, "host-b", "http://host-b:3774");
    db.assignRelayPorts(9001);
    expect(db.getLink("host-b")).toMatchObject({ t3Url: "http://host-b:3774", relayPort: 9002 });

    db.removeLink("host-a");
    link(db, "host-d", "http://host-d:3773");
    db.assignRelayPorts(9001);
    expect(ports()).toEqual({ "host-b": 9002, "host-c": 9003, "host-d": 9001 });
  });

  it("leaves the relay file readable by Caddy under the service's strict umask", async () => {
    await using metaserver = await setup();
    link(metaserver.db, "host-a", "http://host-a:3773");
    const caddyFile = NodePath.join(metaserver.dir, "t3-relays.caddy");
    const previous = process.umask(0o077);
    try {
      await syncRelay(metaserver.db, {
        publicHost: "metaserver.example.ts.net",
        portBase: 9001,
        caddyFile,
        reloadCommand: "true",
      });
    } finally {
      process.umask(previous);
    }
    expect(NodeFS.statSync(caddyFile).mode & 0o777).toBe(0o644);

    // A file an older build left unreadable is fixed even when its content is current.
    NodeFS.chmodSync(caddyFile, 0o600);
    await syncRelay(metaserver.db, {
      publicHost: "metaserver.example.ts.net",
      portBase: 9001,
      caddyFile,
      reloadCommand: "true",
    });
    expect(NodeFS.statSync(caddyFile).mode & 0o777).toBe(0o644);
  });

  it("writes one Caddy site per linked server and reloads only on change", async () => {
    await using metaserver = await setup();
    const { db } = metaserver;
    link(db, "host-a", "http://host-a:3773");
    link(db, "host-b", "https://host-b.example.ts.net");
    const reloads = NodePath.join(metaserver.dir, "reloads");
    const config = {
      publicHost: "metaserver.example.ts.net",
      portBase: 9001,
      caddyFile: NodePath.join(metaserver.dir, "t3-relays.caddy"),
      reloadCommand: `touch ${reloads}`,
    };
    expect(await syncRelay(db, config)).toEqual({ changed: true, error: null });
    const expected = [
      "# Generated by t3-metaserver; edits are overwritten. One site per linked t3 server.",
      "",
      "# host-a",
      "metaserver.example.ts.net:9001 {",
      "\treverse_proxy http://host-a:3773",
      "}",
      "",
      "# host-b",
      "metaserver.example.ts.net:9002 {",
      "\treverse_proxy https://host-b.example.ts.net",
      "}",
      "",
    ].join("\n");
    expect(NodeFS.readFileSync(config.caddyFile, "utf8")).toBe(expected);
    expect(renderRelayCaddy(config.publicHost, db.listLinks().toReversed())).toBe(expected);
    expect(NodeFS.existsSync(reloads)).toBe(true);

    NodeFS.rmSync(reloads);
    expect(await syncRelay(db, config)).toEqual({ changed: false, error: null });
    expect(NodeFS.existsSync(reloads)).toBe(false);

    db.removeLink("host-a");
    const logged: string[] = [];
    const failed = await syncRelay(db, { ...config, reloadCommand: "false" }, (line) =>
      logged.push(line),
    );
    expect(failed.changed).toBe(true);
    expect(failed.error).not.toBeNull();
    expect(logged).toHaveLength(1);
    expect(NodeFS.readFileSync(config.caddyFile, "utf8")).not.toContain("host-a");
  });

  it("serves the fleet MCP: fleet tools plus proxied T3 tools that route by server", async () => {
    await using metaserver = await setup();
    const unauthorized = await fetch(`${metaserver.base}/mcp`, { method: "POST", body: "{}" });
    expect(unauthorized.status).toBe(401);

    const { token } = metaserver.db.issueToken("agent", "host-a");
    const client = new T3Client(`${metaserver.base}/mcp`, token);
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
    expect(metaserver.t3.calls.at(-1)).toEqual({
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
    await using metaserver = await setup();
    metaserver.db.replaceServices(
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
    const [found] = metaserver.fleet.findServices("RustDesk");
    expect(found).toMatchObject({
      server: { id: "host-a", ssh: "ssh deploy@host-a.example.ts.net" },
      updateHint: "cd /opt/rustdesk && docker compose pull && docker compose up -d",
    });
    expect(metaserver.fleet.findServices("nginx")).toEqual([]);
  });

  it("pushes new pending requests and finished turns, but not on the first poll", async () => {
    await using metaserver = await setup();
    metaserver.db.enrollDevice("phone", null);
    const device = metaserver.db.listDevices()[0]!;
    metaserver.db.setPushToken(device.id, "a".repeat(64), "sandbox");
    const sent: PushMessage[] = [];
    const watcher = new Watcher(metaserver.db, metaserver.fleet, async (_token, _env, message) => {
      sent.push(message);
      return { ok: true };
    });

    metaserver.t3.state.threads = [
      { threadId: "t1", title: "Old", status: "waiting", pendingRequestCount: 1 },
    ];
    metaserver.t3.state.pending = [{ requestId: "r-old", summary: "old request" }];
    await watcher.poll();
    expect(sent).toEqual([]);

    metaserver.t3.state.threads = [
      { threadId: "t1", title: "Old", status: "waiting", pendingRequestCount: 2 },
      { threadId: "t2", title: "Build", status: "running", pendingRequestCount: 0 },
    ];
    metaserver.t3.state.pending = [
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

    metaserver.t3.state.threads = [
      { threadId: "t2", title: "Build", status: "completed", pendingRequestCount: 0 },
    ];
    metaserver.t3.state.pending = [];
    await watcher.poll();
    expect(sent.at(-1)).toEqual({
      title: "host-a: done",
      body: "Build",
      data: { kind: "turn", serverId: "host-a", threadId: "t2" },
    });
  });
});
