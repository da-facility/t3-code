import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import type { HubDevice } from "./fleetModel";

/**
 * The phone's link to the fleet hub: its URL and this device's token, kept in
 * the Keychain. One hub per phone.
 */

export interface HubLink {
  readonly url: string;
  readonly token: string;
  readonly deviceId: string;
}

const STORAGE_KEY = "scope.hub.v1";

let current: HubLink | null | undefined;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export async function loadHubLink(): Promise<HubLink | null> {
  if (current !== undefined) return current;
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    current = raw ? (JSON.parse(raw) as HubLink) : null;
  } catch {
    // An unreadable Keychain entry means not connected; enrolling again replaces it.
    current = null;
  }
  emit();
  return current;
}

async function saveHubLink(link: HubLink | null) {
  if (link) await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(link));
  else await SecureStore.deleteItemAsync(STORAGE_KEY);
  current = link;
  emit();
}

/** undefined while the Keychain read is in flight. */
export function useHubLink(): HubLink | null | undefined {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      if (current === undefined) void loadHubLink();
      return () => listeners.delete(listener);
    },
    () => current,
  );
}

export class HubError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function hubRequest<T>(
  link: Pick<HubLink, "url" | "token"> | { url: string; token: null },
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
      throw new HubError(response.status, parsed.error ?? `Hub returned HTTP ${response.status}`);
    return parsed as T;
  } catch (error) {
    if (error instanceof HubError) throw error;
    throw new HubError(
      0,
      controller.signal.aborted ? "The hub did not answer. Is Tailscale connected?" : String(error),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function enrollWithHub(url: string, name: string): Promise<HubDevice> {
  const result = await hubRequest<{ device: HubDevice; token: string }>(
    { url, token: null },
    "/api/enroll",
    { name },
  );
  await saveHubLink({ url, token: result.token, deviceId: result.device.id });
  return result.device;
}

export async function forgetHub() {
  await saveHubLink(null);
}
