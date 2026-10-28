import * as NodeCrypto from "node:crypto";
import * as NodeSqlite from "node:sqlite";

import type { RegistryServer, RegistryServerInput, RegistryService } from "@t3tools/fleet/registry";

/**
 * Metaserver state. One SQLite file, owned by root with mode 600. Credentials for
 * T3 servers are stored as-is because the metaserver must present them; tokens the
 * metaserver hands out (fleet MCP, devices) are stored only as SHA-256 hashes.
 */

const MIGRATIONS = [
  `CREATE TABLE servers (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    user TEXT,
    port INTEGER NOT NULL DEFAULT 22,
    key_name TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    sources TEXT NOT NULL DEFAULT '[]',
    t3_url TEXT,
    notes TEXT,
    last_scan_at TEXT,
    last_scan_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE services (
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT,
    image TEXT,
    compose_dir TEXT,
    config_files TEXT NOT NULL DEFAULT '[]',
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (server_id, kind, name)
  );
  CREATE TABLE links (
    server_id TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
    t3_url TEXT NOT NULL,
    bearer_token TEXT NOT NULL,
    mcp_token TEXT NOT NULL,
    linked_at TEXT NOT NULL,
    last_ok_at TEXT,
    last_error TEXT
  );
  CREATE TABLE tokens (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    server_id TEXT,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    status TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    public_key TEXT,
    apns_token TEXT,
    apns_env TEXT,
    created_at TEXT NOT NULL,
    approved_by TEXT,
    approved_at TEXT,
    revoked_at TEXT,
    last_seen_at TEXT
  );
  CREATE TABLE seen (
    key TEXT PRIMARY KEY,
    at TEXT NOT NULL
  );
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );`,
];

export const hashToken = (token: string) =>
  NodeCrypto.createHash("sha256").update(token).digest("hex");

export const newToken = (prefix: string) =>
  `${prefix}_${NodeCrypto.randomBytes(32).toString("base64url")}`;

export interface Link {
  serverId: string;
  t3Url: string;
  bearerToken: string;
  mcpToken: string;
  linkedAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

export type DeviceRole = "owner" | "member";
export type DeviceStatus = "pending" | "approved" | "revoked";

export interface Device {
  id: string;
  name: string;
  role: DeviceRole;
  status: DeviceStatus;
  publicKey: string | null;
  apnsToken: string | null;
  apnsEnv: string | null;
  createdAt: string;
  approvedBy: string | null;
  approvedAt: string | null;
  revokedAt: string | null;
  lastSeenAt: string | null;
}

type Row = Record<string, unknown>;
const str = (value: unknown) => (value === null || value === undefined ? null : String(value));
const json = <T>(value: unknown, fallback: T): T => {
  try {
    return value ? (JSON.parse(String(value)) as T) : fallback;
  } catch {
    return fallback;
  }
};

const toServer = (row: Row): RegistryServer => ({
  id: String(row.id),
  address: String(row.address),
  user: str(row.user),
  port: Number(row.port),
  keyName: str(row.key_name),
  tags: json(row.tags, []),
  sources: json(row.sources, []),
  t3Url: str(row.t3_url),
  notes: str(row.notes),
  lastScanAt: str(row.last_scan_at),
  lastScanError: str(row.last_scan_error),
});

const toService = (row: Row): RegistryService => ({
  serverId: String(row.server_id),
  kind: row.kind as RegistryService["kind"],
  name: String(row.name),
  status: str(row.status),
  image: str(row.image),
  composeDir: str(row.compose_dir),
  configFiles: json(row.config_files, []),
  scannedAt: String(row.scanned_at),
});

const toLink = (row: Row): Link => ({
  serverId: String(row.server_id),
  t3Url: String(row.t3_url),
  bearerToken: String(row.bearer_token),
  mcpToken: String(row.mcp_token),
  linkedAt: String(row.linked_at),
  lastOkAt: str(row.last_ok_at),
  lastError: str(row.last_error),
});

const toDevice = (row: Row): Device => ({
  id: String(row.id),
  name: String(row.name),
  role: row.role as DeviceRole,
  status: row.status as DeviceStatus,
  publicKey: str(row.public_key),
  apnsToken: str(row.apns_token),
  apnsEnv: str(row.apns_env),
  createdAt: String(row.created_at),
  approvedBy: str(row.approved_by),
  approvedAt: str(row.approved_at),
  revokedAt: str(row.revoked_at),
  lastSeenAt: str(row.last_seen_at),
});

export class MetaserverDb {
  readonly db: NodeSqlite.DatabaseSync;
  private readonly now: () => Date;

  constructor(path: string, now: () => Date = () => new Date()) {
    this.now = now;
    this.db = new NodeSqlite.DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
    );
    this.migrate();
  }

  private iso() {
    return this.now().toISOString();
  }

  private migrate() {
    this.db.exec("CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY)");
    const done = new Set(
      (this.db.prepare("SELECT version FROM migrations").all() as Row[]).map((row) =>
        Number(row.version),
      ),
    );
    MIGRATIONS.forEach((sql, index) => {
      if (done.has(index)) return;
      this.db.exec("BEGIN");
      try {
        this.db.exec(sql);
        this.db.prepare("INSERT INTO migrations (version) VALUES (?)").run(index);
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  close() {
    this.db.close();
  }

  // Registry

  upsertServer(input: RegistryServerInput): RegistryServer {
    const existing = this.getServer(input.id);
    const now = this.iso();
    const merged = {
      address: input.address,
      user: input.user !== undefined ? input.user : (existing?.user ?? null),
      port: input.port ?? existing?.port ?? 22,
      keyName: input.keyName !== undefined ? input.keyName : (existing?.keyName ?? null),
      tags: [...new Set([...(existing?.tags ?? []), ...(input.tags ?? [])])],
      sources: [...new Set([...(existing?.sources ?? []), ...(input.sources ?? ["manual"])])],
      t3Url: input.t3Url !== undefined ? input.t3Url : (existing?.t3Url ?? null),
      notes: input.notes !== undefined ? input.notes : (existing?.notes ?? null),
    };
    this.db
      .prepare(
        `INSERT INTO servers (id, address, user, port, key_name, tags, sources, t3_url, notes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET address = excluded.address, user = excluded.user, port = excluded.port,
           key_name = excluded.key_name, tags = excluded.tags, sources = excluded.sources,
           t3_url = excluded.t3_url, notes = excluded.notes, updated_at = excluded.updated_at`,
      )
      .run(
        input.id,
        merged.address,
        merged.user,
        merged.port,
        merged.keyName,
        JSON.stringify(merged.tags),
        JSON.stringify(merged.sources),
        merged.t3Url,
        merged.notes,
        now,
        now,
      );
    return this.getServer(input.id)!;
  }

  getServer(id: string): RegistryServer | null {
    const row = this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
    return row ? toServer(row) : null;
  }

  listServers(): RegistryServer[] {
    return (this.db.prepare("SELECT * FROM servers ORDER BY id").all() as Row[]).map(toServer);
  }

  removeServer(id: string) {
    return this.db.prepare("DELETE FROM servers WHERE id = ?").run(id).changes > 0;
  }

  replaceServices(serverId: string, services: RegistryService[], error: string | null) {
    const now = this.iso();
    this.db.exec("BEGIN");
    try {
      if (error === null) {
        this.db.prepare("DELETE FROM services WHERE server_id = ?").run(serverId);
        const insert = this.db.prepare(
          `INSERT OR REPLACE INTO services (server_id, kind, name, status, image, compose_dir, config_files, scanned_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const service of services) {
          insert.run(
            serverId,
            service.kind,
            service.name,
            service.status,
            service.image,
            service.composeDir,
            JSON.stringify(service.configFiles),
            service.scannedAt,
          );
        }
      }
      this.db
        .prepare("UPDATE servers SET last_scan_at = ?, last_scan_error = ? WHERE id = ?")
        .run(now, error, serverId);
      this.db.exec("COMMIT");
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  listServices(serverId?: string): RegistryService[] {
    const rows = serverId
      ? this.db
          .prepare("SELECT * FROM services WHERE server_id = ? ORDER BY kind, name")
          .all(serverId)
      : this.db.prepare("SELECT * FROM services ORDER BY server_id, kind, name").all();
    return (rows as Row[]).map(toService);
  }

  // Links to T3 servers

  setLink(serverId: string, t3Url: string, bearerToken: string, mcpToken: string) {
    this.db
      .prepare(
        `INSERT INTO links (server_id, t3_url, bearer_token, mcp_token, linked_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET t3_url = excluded.t3_url, bearer_token = excluded.bearer_token,
           mcp_token = excluded.mcp_token, linked_at = excluded.linked_at, last_error = NULL`,
      )
      .run(serverId, t3Url, bearerToken, mcpToken, this.iso());
    this.db.prepare("UPDATE servers SET t3_url = ? WHERE id = ?").run(t3Url, serverId);
  }

  getLink(serverId: string): Link | null {
    const row = this.db.prepare("SELECT * FROM links WHERE server_id = ?").get(serverId) as
      | Row
      | undefined;
    return row ? toLink(row) : null;
  }

  listLinks(): Link[] {
    return (this.db.prepare("SELECT * FROM links ORDER BY server_id").all() as Row[]).map(toLink);
  }

  removeLink(serverId: string) {
    return this.db.prepare("DELETE FROM links WHERE server_id = ?").run(serverId).changes > 0;
  }

  markLink(serverId: string, error: string | null) {
    if (error === null) {
      this.db
        .prepare("UPDATE links SET last_ok_at = ?, last_error = NULL WHERE server_id = ?")
        .run(this.iso(), serverId);
    } else {
      this.db.prepare("UPDATE links SET last_error = ? WHERE server_id = ?").run(error, serverId);
    }
  }

  // Fleet MCP tokens

  /** A host keeps one token: issuing a new one for a server revokes its old ones. */
  issueToken(label: string, serverId: string | null) {
    if (serverId !== null) {
      this.db
        .prepare("UPDATE tokens SET revoked_at = ? WHERE server_id = ? AND revoked_at IS NULL")
        .run(this.iso(), serverId);
    }
    const token = newToken("fleet");
    const id = NodeCrypto.randomUUID();
    this.db
      .prepare(
        "INSERT INTO tokens (id, label, server_id, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, label, serverId, hashToken(token), this.iso());
    return { id, token };
  }

  verifyToken(token: string) {
    const row = this.db
      .prepare(
        "SELECT id, label, server_id FROM tokens WHERE token_hash = ? AND revoked_at IS NULL",
      )
      .get(hashToken(token)) as Row | undefined;
    return row
      ? { id: String(row.id), label: String(row.label), serverId: str(row.server_id) }
      : null;
  }

  listTokens() {
    return (
      this.db
        .prepare(
          "SELECT id, label, server_id, created_at, revoked_at FROM tokens ORDER BY created_at",
        )
        .all() as Row[]
    ).map((row) => ({
      id: String(row.id),
      label: String(row.label),
      serverId: str(row.server_id),
      createdAt: String(row.created_at),
      revokedAt: str(row.revoked_at),
    }));
  }

  revokeToken(id: string) {
    return (
      this.db
        .prepare("UPDATE tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(this.iso(), id).changes > 0
    );
  }

  // Devices

  /** The first device ever enrolled becomes the owner; later ones wait for approval. */
  enrollDevice(name: string, publicKey: string | null) {
    const token = newToken("dev");
    const id = NodeCrypto.randomUUID();
    const now = this.iso();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const count = Number(
        (
          this.db
            .prepare("SELECT COUNT(*) AS n FROM devices WHERE status != 'revoked'")
            .get() as Row
        ).n,
      );
      const first = count === 0;
      this.db
        .prepare(
          `INSERT INTO devices (id, name, role, status, token_hash, public_key, created_at, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name,
          first ? "owner" : "member",
          first ? "approved" : "pending",
          hashToken(token),
          publicKey,
          now,
          first ? now : null,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return { device: this.getDevice(id)!, token };
  }

  getDevice(id: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return row ? toDevice(row) : null;
  }

  deviceByToken(token: string): Device | null {
    const row = this.db
      .prepare("SELECT * FROM devices WHERE token_hash = ?")
      .get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    this.db
      .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
      .run(this.iso(), row.id as string);
    return toDevice(row);
  }

  listDevices(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as Row[]).map(
      toDevice,
    );
  }

  approveDevice(id: string, approvedBy: string) {
    return (
      this.db
        .prepare(
          "UPDATE devices SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'pending'",
        )
        .run(approvedBy, this.iso(), id).changes > 0
    );
  }

  revokeDevice(id: string) {
    return (
      this.db
        .prepare(
          "UPDATE devices SET status = 'revoked', revoked_at = ?, apns_token = NULL WHERE id = ? AND status != 'revoked'",
        )
        .run(this.iso(), id).changes > 0
    );
  }

  setDevicePublicKey(id: string, publicKey: string) {
    this.db.prepare("UPDATE devices SET public_key = ? WHERE id = ?").run(publicKey, id);
  }

  setPushToken(id: string, apnsToken: string | null, apnsEnv: string | null) {
    this.db
      .prepare("UPDATE devices SET apns_token = ?, apns_env = ? WHERE id = ?")
      .run(apnsToken, apnsEnv, id);
  }

  // Seen-event bookkeeping for notifications

  markSeen(key: string): boolean {
    return (
      this.db.prepare("INSERT OR IGNORE INTO seen (key, at) VALUES (?, ?)").run(key, this.iso())
        .changes > 0
    );
  }

  pruneSeen(olderThan: Date) {
    this.db.prepare("DELETE FROM seen WHERE at < ?").run(olderThan.toISOString());
  }

  getKv(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  listKv(prefix: string): Array<{ key: string; value: string }> {
    return (
      this.db
        .prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key")
        .all(`${prefix}%`) as Row[]
    ).map((row) => ({ key: String(row.key), value: String(row.value) }));
  }

  setKv(key: string, value: string | null) {
    if (value === null) this.db.prepare("DELETE FROM kv WHERE key = ?").run(key);
    else this.db.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)").run(key, value);
  }
}
