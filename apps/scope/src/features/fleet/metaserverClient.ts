import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import type { MetaserverDevice } from "./fleetModel";

/**
 * The phone's link to the t3 metaserver: its URL and this device's token, kept in
 * the Keychain. One metaserver per phone.
 */

export interface MetaserverLink {
  readonly url: string;
  readonly token: string;
  readonly deviceId: string;
}

// Named before the hub became the metaserver; kept so enrolled phones stay enrolled.
const STORAGE_KEY = "scope.hub.v1";

let current: MetaserverLink | null | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export async function loadMetaserverLink(): Promise<MetaserverLink | null> {
  if (current !== undefined) return current;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    current = raw ? (JSON.parse(raw) as MetaserverLink) : null;
  } catch {
    // An unreadable Keychain entry means not connected; enrolling again replaces it.
    current = null;
  }
  emit();
  return current;
}

async function saveMetaserverLink(link: MetaserverLink | null) {
  if (link) await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(link));
  else await SecureStore.deleteItemAsync(STORAGE_KEY);
  current = link;
  emit();
}

/** undefined while the Keychain read is in flight. */
export function useMetaserverLink(): MetaserverLink | null | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      if (current === undefined) void loadMetaserverLink();
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export class MetaserverError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function metaserverRequest<T>(
  link: Pick<MetaserverLink, "url" | "token"> | { url: string; token: null },
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${link.url}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(link.token ? { authorization: `Bearer ${link.token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? (JSON.parse(text) as { error?: string }) : {};
    if (!response.ok)
      throw new MetaserverError(
        response.status,
        parsed.error ?? `Metaserver returned HTTP ${response.status}`,
      );
    return parsed as T;
  } catch (error) {
    if (error instanceof MetaserverError) throw error;
    throw new MetaserverError(
      0,
      controller.signal.aborted
        ? "The metaserver did not answer. Is Tailscale connected?"
        : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function enrollWithMetaserver(url: string, name: string): Promise<MetaserverDevice> {
  const result = await metaserverRequest<{ device: MetaserverDevice; token: string }>(
    { url, token: null },
    "/api/enroll",
    { name },
  );
  await saveMetaserverLink({ url, token: result.token, deviceId: result.device.id });
  return result.device;
}

/**
 * When the saved address stops answering, tries the address this build was made for with the
 * same device token, and keeps it if the metaserver knows the device. Covers a renamed metaserver.
 */
export async function moveToBuildMetaserver(
  link: MetaserverLink,
  buildUrl: string | null,
): Promise<boolean> {
  if (!buildUrl || buildUrl === link.url) return false;
  try {
    await metaserverRequest({ url: buildUrl, token: link.token }, "/api/me");
  } catch {
    return false;
  }
  await saveMetaserverLink({ ...link, url: buildUrl });
  return true;
}

export async function forgetMetaserver() {
  await saveMetaserverLink(null);
}
