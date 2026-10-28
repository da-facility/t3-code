import type { MetaserverDb } from "../db.ts";
import type { RouteContext } from "../http.ts";
import { HttpError } from "../http.ts";
import type { Sealed } from "./hpke.ts";
import { type Vault, VaultError } from "./vault.ts";

const P256_PUBLIC_KEY = /^[A-Za-z0-9+/]{86}[A-Za-z0-9+/=]{2}$/;

const isSealed = (value: unknown): value is Sealed =>
  !!value && typeof (value as Sealed).enc === "string" && typeof (value as Sealed).ct === "string";

/** Phone-facing vault routes under /api/vault. Every route needs an approved device. */
export function vaultRoutes(db: MetaserverDb, vault: Vault) {
  return async (context: RouteContext): Promise<boolean> => {
    const { method, path, send } = context;
    if (!path.startsWith("/api/vault")) return false;
    const device = context.device!;
    try {
      if (method === "GET" && path === "/api/vault") {
        send(200, vault.status(device.id));
        return true;
      }
      if (method === "POST" && path === "/api/vault/key") {
        const body = (await context.body()) as { publicKey?: unknown };
        const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : "";
        if (
          !P256_PUBLIC_KEY.test(publicKey) ||
          !Buffer.from(publicKey, "base64")
            .subarray(0, 1)
            .equals(Buffer.from([4]))
        ) {
          throw new HttpError(400, "Expected an uncompressed P-256 public key, base64.");
        }
        if (device.publicKey !== publicKey) {
          db.setDevicePublicKey(device.id, publicKey);
          vault.onDeviceKeyChanged(device.id);
        }
        send(200, vault.status(device.id));
        return true;
      }
      if (method === "POST" && path === "/api/vault/unlock/start") {
        send(200, await vault.startUnlock(device.id));
        return true;
      }
      if (method === "POST" && path === "/api/vault/unlock/finish") {
        const body = (await context.body()) as { challengeId?: unknown; sealedKey?: unknown };
        if (typeof body.challengeId !== "string" || !isSealed(body.sealedKey)) {
          throw new HttpError(400, "Expected challengeId and sealedKey.");
        }
        send(200, await vault.finishUnlock(device.id, body.challengeId, body.sealedKey));
        return true;
      }
      if (method === "POST" && path === "/api/vault/heartbeat") {
        send(200, { alive: vault.heartbeat(device.id), ...vault.status(device.id) });
        return true;
      }
      if (method === "POST" && path === "/api/vault/lock") {
        await vault.lock("phone closed the approval screen");
        send(200, vault.status(device.id));
        return true;
      }
      if (method === "GET" && path === "/api/vault/requests") {
        send(200, { requests: vault.listRequests() });
        return true;
      }
      const match = /^\/api\/vault\/requests\/([^/]+)(\/refresh)?$/.exec(path);
      if (method === "POST" && match) {
        if (match[2]) {
          send(200, { request: await vault.refreshOptions(match[1]!) });
          return true;
        }
        const body = (await context.body()) as { approve?: unknown; itemId?: unknown };
        await vault.decide(
          match[1]!,
          device.id,
          body.approve === true,
          typeof body.itemId === "string" ? body.itemId : undefined,
        );
        send(200, { ok: true });
        return true;
      }
      return false;
    } catch (error) {
      if (error instanceof VaultError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };
}
