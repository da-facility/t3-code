import type { MetaserverDb } from "./db.ts";
import type { Fleet, ServerOverview } from "./fleet.ts";
import type { PushMessage, PushResult } from "./apns.ts";

export type PushFn = (
  deviceToken: string,
  environment: string | null,
  message: PushMessage,
) => Promise<PushResult>;

const ACTIVE = new Set(["preparing", "queued", "starting", "running"]);
const FINISHED = new Set(["completed", "failed", "interrupted", "cancelled"]);

/**
 * Polls every linked server and notifies enrolled phones: a new pending
 * request is time-sensitive, a finished turn is a normal alert. The first
 * poll after start only records state, so a restart never replays old alerts.
 */
export class Watcher {
  private readonly db: MetaserverDb;
  private readonly fleet: Fleet;
  private readonly push: PushFn;
  private readonly statuses = new Map<string, string>();
  private seeded = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(db: MetaserverDb, fleet: Fleet, push: PushFn) {
    this.db = db;
    this.fleet = fleet;
    this.push = push;
  }

  start(intervalMs: number) {
    const tick = () => {
      this.running ??= this.poll()
        .catch(() => {})
        .finally(() => {
          this.running = null;
        });
    };
    tick();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    const overviews = await this.fleet.overviewAll();
    for (const overview of overviews) await this.process(overview);
    this.db.pruneSeen(new Date(Date.now() - 30 * 24 * 3600_000));
  }

  async process(overview: ServerOverview) {
    if (!overview.ok) return;
    const firstPass = !this.seeded.has(overview.serverId);
    const messages: PushMessage[] = [];

    for (const request of overview.pending) {
      const fresh = this.db.markSeen(`pending:${overview.serverId}:${request.requestId}`);
      if (fresh && !firstPass) {
        messages.push({
          title: `${overview.serverId}: needs you`,
          body: `${request.threadTitle ?? "A thread"}: ${request.summary}`,
          timeSensitive: true,
          data: {
            kind: "pending",
            serverId: overview.serverId,
            threadId: request.threadId,
            requestId: request.requestId,
          },
        });
      }
    }

    for (const thread of overview.threads) {
      const key = `${overview.serverId}:${thread.threadId}`;
      const previous = this.statuses.get(key);
      const status = thread.status ?? "";
      this.statuses.set(key, status);
      if (!firstPass && previous && ACTIVE.has(previous) && FINISHED.has(status)) {
        messages.push({
          title: `${overview.serverId}: ${status === "completed" ? "done" : status}`,
          body: thread.title ?? "A thread finished",
          data: { kind: "turn", serverId: overview.serverId, threadId: thread.threadId },
        });
      }
    }
    this.seeded.add(overview.serverId);

    if (messages.length === 0) return;
    const devices = this.db
      .listDevices()
      .filter((device) => device.status === "approved" && device.apnsToken);
    for (const message of messages) {
      for (const device of devices) {
        const result = await this.push(device.apnsToken!, device.apnsEnv, message);
        if (!result.ok && result.unregistered) this.db.setPushToken(device.id, null, null);
      }
    }
  }
}
