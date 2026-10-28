import {
  connectionCatalogDisplayUrl,
  connectionRouteId,
  connectionRoutes,
  EnvironmentRegistry,
  isLearned,
  routeHttpBaseUrl,
} from "@t3tools/client-runtime/connection";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { environmentCatalog } from "../../connection/catalog";
import { connectPairingUrl } from "../../connection/onboarding";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  type FleetServerRow,
  type MetaserverOverview,
  type MetaserverServer,
  routesOffRelay,
  type SavedEnvironment,
  serversOffRelay,
  summarizeFleet,
} from "./fleetModel";
import { type MetaserverLink, metaserverRequest } from "./metaserverClient";

/**
 * Pairing an environment that is already saved adds the new address as another route
 * of the same entry, after the old one. This drops the old routes, keeping the cache.
 */
const dropRoutesOffRelay = createRuntimeCommand(connectionAtomRuntime, {
  label: "scope:fleet:drop-routes-off-relay",
  concurrency: {
    mode: "serial",
    key: (input: { readonly environmentId: EnvironmentId; readonly relayUrl: string }) =>
      input.environmentId,
  },
  execute: Effect.fn("ScopeFleet.dropRoutesOffRelay")(function* (input: {
    readonly environmentId: EnvironmentId;
    readonly relayUrl: string;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(input.environmentId);
    if (entry === undefined) return;
    const routes = connectionRoutes(entry).map((route) => ({
      id: connectionRouteId(route.target),
      httpBaseUrl: routeHttpBaseUrl(route),
      learned: isLearned(route),
    }));
    for (const routeId of routesOffRelay(routes, input.relayUrl)) {
      yield* registry.removeRoute(input.environmentId, routeId);
    }
  }),
});

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Pairs this phone with a server through a metaserver-minted link. Returns an error message or null. */
export async function pairThroughMetaserver(
  link: MetaserverLink,
  row: FleetServerRow,
): Promise<string | null> {
  try {
    const pairing = await metaserverRequest<{ pairingUrl: string }>(
      link,
      `/api/servers/${row.server.id}/pairing`,
      {},
    );
    const environmentId = (row.environmentId ?? undefined) as EnvironmentId | undefined;
    const connected = await runAtomCommand(
      appAtomRegistry,
      connectPairingUrl,
      {
        pairingUrl: pairing.pairingUrl,
        ...(environmentId === undefined ? {} : { expectedEnvironmentId: environmentId }),
      },
      { reportFailure: false },
    );
    if (connected._tag === "Failure") {
      return row.server.relayUrl
        ? `Scope could not reach ${row.server.id} through the metaserver.`
        : `Scope could not reach ${row.server.id} directly. Is Tailscale on?`;
    }
    if (row.server.relayUrl) {
      await runAtomCommand(
        appAtomRegistry,
        dropRoutesOffRelay,
        { environmentId: connected.value, relayUrl: row.server.relayUrl },
        { reportFailure: false },
      );
    }
    return null;
  } catch (cause) {
    return describe(cause);
  }
}

const savedEnvironments = (): ReadonlyArray<SavedEnvironment> =>
  [...appAtomRegistry.get(environmentCatalog.catalogValueAtom).entries].map(
    ([environmentId, entry]) => ({
      environmentId,
      displayUrl: connectionCatalogDisplayUrl(entry) ?? "",
    }),
  );

const relayMovesTried = new Set<string>();
let relayMoves: Promise<void> = Promise.resolve();

/**
 * Quietly re-pairs saved servers onto their relay, one at a time and at most once per
 * server per app session. A failed move leaves the old connection as it was.
 */
export function moveServersOntoRelay(
  link: MetaserverLink,
  servers: ReadonlyArray<MetaserverServer>,
  overviews: ReadonlyArray<MetaserverOverview>,
) {
  const rows = serversOffRelay(summarizeFleet(servers, overviews).servers, savedEnvironments());
  for (const row of rows) {
    if (relayMovesTried.has(row.server.id)) continue;
    relayMovesTried.add(row.server.id);
    relayMoves = relayMoves.then(async () => {
      if (serversOffRelay([row], savedEnvironments()).length === 0) return;
      await pairThroughMetaserver(link, row);
    });
  }
}
