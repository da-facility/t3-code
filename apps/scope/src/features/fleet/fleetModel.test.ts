import { describe, expect, it } from "vite-plus/test";

import {
  type MetaserverOverview,
  type MetaserverServer,
  type FleetServerRow,
  isServerConnected,
  normalizeMetaserverUrl,
  relativeTime,
  routesOffRelay,
  serversOffRelay,
  summarizeFleet,
} from "./fleetModel";

const server = (id: string, linked = true): MetaserverServer => ({
  id,
  address: `${id}.example.ts.net`,
  ssh: `ssh ${id}.example.ts.net`,
  tags: [],
  serviceCount: 0,
  t3: { url: linked ? `http://${id}:3773` : null, linked, lastOkAt: null, lastError: null },
  relayUrl: null,
});

describe("normalizeMetaserverUrl", () => {
  it("defaults to HTTPS, and to the metaserver's port for plain HTTP", () => {
    expect(normalizeMetaserverUrl("metaserver.example.ts.net")).toBe(
      "https://metaserver.example.ts.net",
    );
    expect(normalizeMetaserverUrl("http://metaserver.example.ts.net")).toBe(
      "http://metaserver.example.ts.net:8780",
    );
    expect(normalizeMetaserverUrl(" http://metaserver:9000/ ")).toBe("http://metaserver:9000");
    expect(normalizeMetaserverUrl("https://metaserver.example.ts.net")).toBe(
      "https://metaserver.example.ts.net",
    );
  });

  it("rejects what is not a URL", () => {
    expect(normalizeMetaserverUrl("")).toBeNull();
    expect(normalizeMetaserverUrl("ftp://metaserver")).toBeNull();
    expect(normalizeMetaserverUrl("http://")).toBeNull();
  });
});

describe("summarizeFleet", () => {
  const overviews: MetaserverOverview[] = [
    {
      serverId: "host-a",
      ok: true,
      error: null,
      environment: { environmentId: "env-a", label: "Host A" },
      threads: [
        {
          serverId: "host-a",
          projectId: "p",
          projectTitle: "P",
          threadId: "t1",
          title: "Deploy",
          status: "waiting",
          updatedAt: "2026-01-01T00:02:00Z",
        },
        {
          serverId: "host-a",
          projectId: "p",
          projectTitle: "P",
          threadId: "t2",
          title: "Fix",
          status: "running",
          updatedAt: "2026-01-01T00:01:00Z",
        },
        {
          serverId: "host-a",
          projectId: "p",
          projectTitle: "P",
          threadId: "t3",
          title: "Old",
          status: "completed",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
      pending: [],
    },
    {
      serverId: "host-b",
      ok: false,
      error: "connect ECONNREFUSED",
      environment: null,
      threads: [],
      pending: [],
    },
  ];

  it("ranks servers that need attention first and reports health", () => {
    const summary = summarizeFleet(
      [server("host-b"), server("host-a"), server("host-c", false)],
      overviews,
    );
    expect(
      summary.servers.map((row) => [row.server.id, row.health, row.waiting, row.running]),
    ).toEqual([
      ["host-a", "online", 1, 1],
      ["host-b", "error", 0, 0],
    ]);
    expect(summary.servers[0]!.environmentId).toBe("env-a");
    expect(summary.others.map((other) => other.id)).toEqual(["host-c"]);
  });

  it("lists waiting threads as needing approval even when no question is listed", () => {
    const summary = summarizeFleet([server("host-a")], overviews);
    expect(summary.attention).toEqual([
      expect.objectContaining({ threadId: "t1", summary: "Waiting for approval", requestId: null }),
    ]);
    expect(summary.recent.map((thread) => thread.threadId)).toEqual(["t2", "t3"]);
  });

  it("uses a listed question's summary instead", () => {
    const withQuestion = [
      {
        ...overviews[0]!,
        pending: [
          {
            serverId: "host-a",
            threadId: "t1",
            threadTitle: "Deploy",
            requestId: "r1",
            summary: "Which region?",
          },
        ],
      },
    ];
    const summary = summarizeFleet([server("host-a")], withQuestion);
    expect(summary.attention).toEqual([
      expect.objectContaining({ threadId: "t1", summary: "Which region?", requestId: "r1" }),
    ]);
  });
});

describe("the metaserver relay", () => {
  const RELAY = "https://metaserver.example.ts.net:9001";
  const row = (relayUrl: string | null): FleetServerRow => ({
    server: { ...server("host-a"), relayUrl },
    health: "online",
    environmentId: "env-a",
    label: "Host A",
    running: 0,
    waiting: 0,
    threads: 0,
    error: null,
  });
  const direct = [{ environmentId: "env-a", displayUrl: "http://host-a:3773/" }];
  const relayed = [{ environmentId: "env-a", displayUrl: `${RELAY}/` }];

  it("counts a server as connected only through its relay, when it has one", () => {
    expect(isServerConnected(row(null), direct)).toBe(true);
    expect(isServerConnected(row(RELAY), direct)).toBe(false);
    expect(isServerConnected(row(RELAY), relayed)).toBe(true);
    // Another server's relay port on the same metaserver is a different origin.
    expect(isServerConnected(row("https://metaserver.example.ts.net:9002"), relayed)).toBe(false);
    expect(isServerConnected(row(RELAY), [])).toBe(false);
  });

  it("moves only saved servers that connect elsewhere", () => {
    const rows = [row(RELAY), { ...row(null), environmentId: "env-b" }];
    expect(serversOffRelay(rows, direct).map((candidate) => candidate.environmentId)).toEqual([
      "env-a",
    ]);
    expect(serversOffRelay(rows, relayed)).toEqual([]);
    expect(serversOffRelay(rows, [])).toEqual([]);
  });

  it("drops paired routes off the relay, but never the last way in", () => {
    const routes = [
      { id: "direct", httpBaseUrl: "http://host-a:3773/", learned: false },
      { id: "relay", httpBaseUrl: `${RELAY}/`, learned: false },
      { id: "learned", httpBaseUrl: "http://100.64.0.1:3773/", learned: true },
      { id: "t3-connect", httpBaseUrl: null, learned: false },
    ];
    expect(routesOffRelay(routes, RELAY)).toEqual(["direct"]);
    expect(routesOffRelay([routes[0]!], RELAY)).toEqual([]);
  });
});

describe("relativeTime", () => {
  it("compacts durations", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T23:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-01-01T23:30:00Z", now)).toBe("30m");
    expect(relativeTime("2026-01-01T20:00:00Z", now)).toBe("4h");
    expect(relativeTime("2025-12-30T00:00:00Z", now)).toBe("3d");
  });
});
