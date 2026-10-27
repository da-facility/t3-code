import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { AppState, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { type HubLink, hubRequest, useHubLink } from "./hubClient";
import { scopeVault } from "./vaultNative";

interface VaultStatus {
  configured: boolean;
  unlocked: boolean;
  unlockedByThisDevice: boolean;
  rotationPending: boolean;
  hasWrappedKey: boolean;
  pendingRequests: number;
}

interface CredentialRequest {
  id: string;
  url: string;
  requester: string;
  options: Array<{ id: string; title: string }>;
}

/**
 * The approval screen. The hub's vault is unlocked only while this screen is
 * open and sending heartbeats; leaving it, or the app going to the background,
 * locks the hub. Every credential use is confirmed here.
 */
export function VaultScreen() {
  const link = useHubLink();
  if (!link) {
    return (
      <View className="flex-1 bg-screen" style={{ justifyContent: "center", padding: 24 }}>
        <Text className="text-base text-muted-foreground">Connect to a hub first.</Text>
      </View>
    );
  }
  return <VaultApproval link={link} />;
}

function VaultApproval({ link }: { readonly link: HubLink }) {
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<VaultStatus | null>(null);
  const [requests, setRequests] = useState<CredentialRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const unlockedHere = useRef(false);

  const lock = useCallback(async () => {
    if (!unlockedHere.current) return;
    unlockedHere.current = false;
    await hubRequest(link, "/api/vault/lock", {}).catch(() => {});
  }, [link]);

  const poll = useCallback(async () => {
    const result = await pollVault(link, unlockedHere.current);
    if ("error" in result) return setMessage(result.error);
    setStatus(result.status);
    if (unlockedHere.current && !result.status.unlockedByThisDevice) unlockedHere.current = false;
    setRequests(result.requests);
  }, [link]);

  useFocusEffect(
    useCallback(() => {
      void poll();
      const timer = setInterval(() => void poll(), 3_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state !== "active") void lock();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
        void lock();
      };
    }, [lock, poll]),
  );

  const registerKey = async () => {
    setBusy(true);
    const result = await registerVaultKey(link);
    setBusy(false);
    if ("error" in result) return setMessage(result.error);
    setStatus(result.status);
    setMessage(result.message);
  };

  const unlock = async () => {
    setBusy(true);
    setMessage(null);
    const result = await unlockVault(link);
    setBusy(false);
    if ("error" in result) return setMessage(result.error);
    unlockedHere.current = result.status.unlockedByThisDevice;
    setStatus(result.status);
  };

  const decide = (request: CredentialRequest, approve: boolean, itemId?: string) => {
    const body = itemId ? { approve, itemId } : { approve };
    void hubRequest(link, `/api/vault/requests/${request.id}`, body).then(
      () => setRequests((current) => current.filter((candidate) => candidate.id !== request.id)),
      (cause: unknown) => setMessage(describe(cause)),
    );
  };

  const host = (url: string) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingHorizontal: 16,
        paddingBottom: 40,
        gap: 16,
      }}
    >
      <Text className="text-4xl font-t3-bold text-foreground">Vault</Text>
      <GlassSurface style={{ padding: 16, gap: 10 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: status?.unlockedByThisDevice ? "#34C759" : "#8E8E93",
            }}
          />
          <Text className="text-lg font-t3-bold text-foreground">
            {status === null
              ? "Checking…"
              : !status.configured
                ? "Not set up on the hub"
                : status.unlockedByThisDevice
                  ? "Unlocked while this screen is open"
                  : status.unlocked
                    ? "Unlocked by another phone"
                    : "Locked"}
          </Text>
        </View>
        {status && !status.configured ? (
          <Text className="text-sm text-muted-foreground">
            Run `fleet-hub vault setup` on the hub after registering this phone's key.
          </Text>
        ) : null}
        {status && !status.hasWrappedKey ? (
          <Button
            label="Register this phone's key"
            tone="secondary"
            onPress={() => void registerKey()}
            loading={busy}
          />
        ) : null}
        {status?.configured && status.hasWrappedKey && !status.unlockedByThisDevice ? (
          <Button
            label="Unlock with Face ID"
            onPress={() => void unlock()}
            loading={busy}
            fullWidth
          />
        ) : null}
        {status?.unlockedByThisDevice ? (
          <Button
            label="Lock now"
            tone="secondary"
            onPress={() => void lock().then(poll)}
            fullWidth
          />
        ) : null}
        {status?.rotationPending ? (
          <Text className="text-xs text-muted-foreground">
            The vault key rotates at the next unlock (a phone was revoked).
          </Text>
        ) : null}
        {message ? <Text className="text-sm text-muted-foreground">{message}</Text> : null}
      </GlassSurface>

      {requests.map((request) => (
        <GlassSurface key={request.id} style={{ padding: 16, gap: 10 }}>
          <Text className="text-lg font-t3-bold text-foreground">
            Sign in to {host(request.url)}?
          </Text>
          <Text className="text-sm text-muted-foreground">Requested by {request.requester}</Text>
          {!status?.unlockedByThisDevice ? (
            <Text className="text-sm text-muted-foreground">Unlock to choose a login.</Text>
          ) : request.options.length === 0 ? (
            <Text className="text-sm text-muted-foreground">
              No 1Password login matches this site.
            </Text>
          ) : (
            request.options.map((option) => (
              <Pressable key={option.id} onPress={() => decide(request, true, option.id)}>
                <GlassSurface style={{ padding: 12 }}>
                  <Text className="text-base font-t3-medium text-foreground">
                    Use “{option.title}”
                  </Text>
                </GlassSurface>
              </Pressable>
            ))
          )}
          <Button label="Deny" tone="danger" onPress={() => decide(request, false)} />
        </GlassSurface>
      ))}
    </ScrollView>
  );
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// Async work lives outside components: React Compiler cannot compile try/finally in them.

async function registerVaultKey(
  link: HubLink,
): Promise<{ status: VaultStatus; message: string } | { error: string }> {
  if (!scopeVault) return { error: "This build has no vault module." };
  try {
    const publicKey = await scopeVault.ensureKey();
    const status = await hubRequest<VaultStatus>(link, "/api/vault/key", { publicKey });
    return {
      status,
      message: scopeVault.isHardwareBacked()
        ? "Vault key created in the Secure Enclave."
        : "Vault key created (software key: no Secure Enclave on this device).",
    };
  } catch (cause) {
    return { error: describe(cause) };
  }
}

/** Face ID opens this phone's wrapped vault key and seals it to the hub's one-time key. */
async function unlockVault(link: HubLink): Promise<{ status: VaultStatus } | { error: string }> {
  if (!scopeVault) return { error: "This build has no vault module." };
  try {
    const challenge = await hubRequest<{
      challengeId: string;
      publicKey: string;
      wrappedKey: { enc: string; ct: string };
    }>(link, "/api/vault/unlock/start", {});
    const sealedKey = await scopeVault.unlock(
      link.deviceId,
      challenge.wrappedKey.enc,
      challenge.wrappedKey.ct,
      challenge.publicKey,
      challenge.challengeId,
      "Unlock your 1Password vault on the hub",
    );
    const status = await hubRequest<VaultStatus>(link, "/api/vault/unlock/finish", {
      challengeId: challenge.challengeId,
      sealedKey,
    });
    return { status };
  } catch (cause) {
    return { error: describe(cause) };
  }
}

/** Status (a heartbeat while this phone holds the unlock) and the waiting requests. */
async function pollVault(
  link: HubLink,
  unlockedHere: boolean,
): Promise<{ status: VaultStatus; requests: CredentialRequest[] } | { error: string }> {
  try {
    const status = unlockedHere
      ? await hubRequest<VaultStatus>(link, "/api/vault/heartbeat", {})
      : await hubRequest<VaultStatus>(link, "/api/vault");
    const list = await hubRequest<{ requests: CredentialRequest[] }>(link, "/api/vault/requests");
    return { status, requests: list.requests };
  } catch (cause) {
    return { error: describe(cause) };
  }
}
