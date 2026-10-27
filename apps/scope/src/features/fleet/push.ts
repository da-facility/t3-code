import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

import { type HubLink, hubRequest } from "./hubClient";

/**
 * Registers this phone's APNs token with the hub, which sends pushes directly
 * (no T3 Connect). Development-signed builds use the APNs sandbox.
 */
export async function registerPushWithHub(
  link: HubLink,
): Promise<"registered" | "denied" | "unsupported"> {
  if (Platform.OS !== "ios") return "unsupported";
  const permission = await Notifications.requestPermissionsAsync({
    ios: { allowAlert: true, allowBadge: true, allowSound: true },
  });
  if (!permission.granted) return "denied";
  const token = await Notifications.getDevicePushTokenAsync();
  const environment =
    (Constants.expoConfig?.extra as { apsEnvironment?: string } | undefined)?.apsEnvironment ===
    "production"
      ? "production"
      : "sandbox";
  await hubRequest(link, "/api/push", { token: String(token.data), environment });
  return "registered";
}

export function sendTestPush(link: HubLink) {
  return hubRequest<{ ok: boolean; reason?: string }>(link, "/api/push/test", {});
}
