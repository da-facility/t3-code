/**
 * Shapes the hub's /api responses for the Fleet screen. Pure, so it is tested
 * without React Native.
 */

export interface HubDevice {
  readonly id: string;
  readonly name: string;
  readonly role: "owner" | "member";
  readonly status: "pending" | "approved" | "revoked";
  readonly hasPush: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

export interface HubServer {
  readonly id: string;
  readonly address: string;
  readonly ssh: string;
  readonly tags: ReadonlyArray<string>;
  readonly serviceCount: number;
  readonly t3: {
    readonly url: string | null;
    readonly linked: boolean;
    readonly lastOkAt: string | null;
    readonly lastError: string | null;
  };
}

export interface HubThread {
  readonly serverId: string;
  readonly projectId: string;
  readonly projectTitle: string | null;
  readonly threadId: string;
  readonly title: string | null;
  readonly status: string | null;
  readonly updatedAt: string | null;
}

export interface HubPending {
  readonly serverId: string;
  readonly threadId: string;
  readonly threadTitle: string | null;
  readonly requestId: string;
  readonly summary: string;
}

export interface HubOverview {
  readonly serverId: string;
  readonly ok: boolean;
  readonly error: string | null;
  readonly environment: { readonly environmentId?: string; readonly label?: string } | null;
  readonly threads: ReadonlyArray<HubThread>;
  readonly pending: ReadonlyArray<HubPending>;
}

/** Accepts a bare tailnet name (served over HTTPS by the hub's Caddy) or a full URL; plain `http://` defaults to the hub port. */
export function normalizeHubUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  const port = url.port || (url.protocol === "http:" ? "8780" : "");
  return `${url.protocol}//${url.hostname}${port ? `:${port}` : ""}`;
}

const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);

export type ServerHealth = "online" | "error" | "unlinked";

export interface FleetServerRow {
  readonly server: HubServer;
  readonly health: ServerHealth;
  readonly environmentId: string | null;
  readonly label: string;
  readonly running: number;
  readonly waiting: number;
  readonly threads: number;
  readonly error: string | null;
}

export interface FleetSummary {
  readonly servers: ReadonlyArray<FleetServerRow>;
  /** Threads that need the user, newest first: listed questions plus threads waiting on an approval. */
  readonly attention: ReadonlyArray<
    HubThread & { readonly summary: string; readonly requestId: string | null }
  >;
  readonly recent: ReadonlyArray<HubThread>;
  /** Registry servers without T3, reachable over SSH. */
  readonly others: ReadonlyArray<HubServer>;
}

const byUpdatedDesc = (a: { updatedAt: string | null }, b: { updatedAt: string | null }) =>
  (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "");

export function summarizeFleet(
  servers: ReadonlyArray<HubServer>,
  overviews: ReadonlyArray<HubOverview>,
  recentLimit = 12,
): FleetSummary {
  const overviewById = new Map(overviews.map((overview) => [overview.serverId, overview]));
  const hasT3 = (server: HubServer) => server.t3.linked || server.t3.url !== null;
  const rows = servers
    .filter(hasT3)
    .map((server): FleetServerRow => {
      const overview = overviewById.get(server.id);
      const threads = overview?.threads ?? [];
      return {
        server,
        health: !server.t3.linked ? "unlinked" : overview && !overview.ok ? "error" : "online",
        environmentId: overview?.environment?.environmentId ?? null,
        label: overview?.environment?.label ?? server.id,
        running: threads.filter((thread) => ACTIVE.has(thread.status ?? "")).length,
        waiting: threads.filter((thread) => thread.status === "waiting").length,
        threads: threads.length,
        error: overview?.error ?? server.t3.lastError,
      };
    })
    .sort(
      (a, b) =>
        b.waiting - a.waiting || b.running - a.running || a.server.id.localeCompare(b.server.id),
    );

  const allThreads = overviews.flatMap((overview) => overview.threads);
  const attention: Array<FleetSummary["attention"][number]> = [];
  for (const overview of overviews) {
    const listed = new Set<string>();
    for (const request of overview.pending) {
      const thread = overview.threads.find((candidate) => candidate.threadId === request.threadId);
      if (!thread) continue;
      listed.add(thread.threadId);
      attention.push({ ...thread, summary: request.summary, requestId: request.requestId });
    }
    for (const thread of overview.threads) {
      if (thread.status === "waiting" && !listed.has(thread.threadId)) {
        attention.push({ ...thread, summary: "Waiting for approval", requestId: null });
      }
    }
  }

  return {
    servers: rows,
    attention: attention.sort(byUpdatedDesc),
    recent: allThreads
      .filter((thread) => thread.status !== "waiting")
      .sort(byUpdatedDesc)
      .slice(0, recentLimit),
    others: servers.filter((server) => !hasT3(server)).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}
