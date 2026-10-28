import { describe, expect, it } from "vite-plus/test";

import {
  type MetaserverOverview,
  type MetaserverServer,
  normalizeMetaserverUrl,
  relativeTime,
  summarizeFleet,
} from "./fleetModel";

const server = (id: string, linked = true): MetaserverServer => ({
  id,
  address: `${id}.example.ts.net`,
  ssh: `ssh ${id}.example.ts.net`,
  tags: [],
  serviceCount: 0,
  t3: { url: linked ? `http://${id}:3773` : null, linked, lastOkAt: null, lastError: null },
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

describe("relativeTime", () => {
  it("compacts durations", () => {
    const now = Date.parse("2026-01-02T00:00:00Z");
    expect(relativeTime("2026-01-01T23:59:30Z", now)).toBe("now");
    expect(relativeTime("2026-01-01T23:30:00Z", now)).toBe("30m");
    expect(relativeTime("2026-01-01T20:00:00Z", now)).toBe("4h");
    expect(relativeTime("2025-12-30T00:00:00Z", now)).toBe("3d");
  });
});
