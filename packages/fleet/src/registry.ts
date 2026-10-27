import * as Schema from "effect/Schema";

/**
 * The fleet registry: every SSH-reachable machine, T3 or not. Only the schema
 * lives in the repo; the rows live on the hub.
 */

export const ServerSource = Schema.Literals(["ssh-config", "tailscale", "ansible", "manual"]);
export type ServerSource = typeof ServerSource.Type;

export const RegistryServer = Schema.Struct({
  /** Stable slug, unique on the hub (e.g. `host-a`). */
  id: Schema.String,
  /** SSH host name or IP the hub and agents connect to. */
  address: Schema.String,
  user: Schema.NullOr(Schema.String),
  port: Schema.Number,
  /** Name of the key a connecting host uses (an IdentityFile basename), never the key itself. */
  keyName: Schema.NullOr(Schema.String),
  tags: Schema.Array(Schema.String),
  sources: Schema.Array(ServerSource),
  /** Base URL of the T3 server on this host, when one is installed. */
  t3Url: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  lastScanAt: Schema.NullOr(Schema.String),
  lastScanError: Schema.NullOr(Schema.String),
});
export type RegistryServer = typeof RegistryServer.Type;

export const ServiceKind = Schema.Literals(["docker", "systemd", "launchd", "brew"]);
export type ServiceKind = typeof ServiceKind.Type;

export const RegistryService = Schema.Struct({
  serverId: Schema.String,
  kind: ServiceKind,
  name: Schema.String,
  /** running, exited, active, inactive, started, ... as the source reports it. */
  status: Schema.NullOr(Schema.String),
  /** Container image with tag, for docker. */
  image: Schema.NullOr(Schema.String),
  /** docker compose working directory. */
  composeDir: Schema.NullOr(Schema.String),
  /** Compose files, unit files or plists that define the service. */
  configFiles: Schema.Array(Schema.String),
  scannedAt: Schema.String,
});
export type RegistryService = typeof RegistryService.Type;

/** A server row as the importer proposes it, before the hub assigns defaults. */
export const RegistryServerInput = Schema.Struct({
  id: Schema.String,
  address: Schema.String,
  user: Schema.optional(Schema.NullOr(Schema.String)),
  port: Schema.optional(Schema.Number),
  keyName: Schema.optional(Schema.NullOr(Schema.String)),
  tags: Schema.optional(Schema.Array(Schema.String)),
  sources: Schema.optional(Schema.Array(ServerSource)),
  t3Url: Schema.optional(Schema.NullOr(Schema.String)),
  notes: Schema.optional(Schema.NullOr(Schema.String)),
});
export type RegistryServerInput = typeof RegistryServerInput.Type;
