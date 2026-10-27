import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { AsyncResult } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useConnectionController } from "../connection/useConnectionController";
import {
  type FleetServerRow,
  type HubDevice,
  type HubOverview,
  type HubServer,
  type HubThread,
  normalizeHubUrl,
  relativeTime,
  summarizeFleet,
} from "./fleetModel";
import { enrollWithHub, forgetHub, type HubLink, hubRequest, useHubLink } from "./hubClient";
import { registerPushWithHub, sendTestPush } from "./push";

/**
 * Scope's home: the whole fleet through the hub. Threads open in the T3
 * workspace UI over a direct connection, which the hub sets up on first tap.
 */
export function FleetScreen() {
  const link = useHubLink();
  if (link === undefined) return <View className="flex-1 bg-screen" />;
  if (link === null) return <HubSetup />;
  return <FleetDashboard link={link} />;
}

const defaultHubUrl =
  (Constants.expoConfig?.extra as { defaultHubUrl?: string | null } | undefined)?.defaultHubUrl ??
  "";

function HubSetup() {
  const insets = useSafeAreaInsets();
  const [url, setUrl] = useState(defaultHubUrl);
  const [name, setName] = useState(Device.deviceName ?? "iPhone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enroll = async () => {
    const normalized = normalizeHubUrl(url);
    if (!normalized) {
      setError("Enter the hub's tailnet address, like hub.example.ts.net.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await enrollWithHub(normalized, name.trim() || "iPhone");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{
        paddingTop: insets.top + 48,
        paddingHorizontal: 20,
        paddingBottom: 40,
        gap: 20,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6 }}>
        <Text className="text-4xl font-t3-bold text-foreground">Scope</Text>
        <Text className="text-base text-muted-foreground">
          Connect to your fleet hub over Tailscale. The first phone becomes the owner; later phones
          are approved from an enrolled one.
        </Text>
      </View>
      <GlassSurface style={{ padding: 16, gap: 12 }}>
        <Text className="text-sm font-t3-medium text-muted-foreground">Hub address</Text>
        <AppTextInput
          className="rounded-xl border border-border px-3 py-3 text-base text-foreground"
          value={url}
          onChangeText={setUrl}
          placeholder="hub.example.ts.net"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Hub address"
        />
        <Text className="text-sm font-t3-medium text-muted-foreground">This phone's name</Text>
        <AppTextInput
          className="rounded-xl border border-border px-3 py-3 text-base text-foreground"
          value={name}
          onChangeText={setName}
          accessibilityLabel="Device name"
        />
        {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
        <Button label="Connect to hub" onPress={() => void enroll()} loading={busy} fullWidth />
      </GlassSurface>
    </ScrollView>
  );
}

interface FleetData {
  fetchedAt: number;
  device: HubDevice;
  servers: HubServer[];
  overviews: HubOverview[];
  devices: HubDevice[];
}

function useFleetData(link: HubLink) {
  const [data, setData] = useState<FleetData | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      try {
        const { device } = await hubRequest<{ device: HubDevice }>(link, "/api/me");
        if (device.status !== "approved") {
          setData({ fetchedAt: Date.now(), device, servers: [], overviews: [], devices: [] });
          setError(null);
          return;
        }
        const [servers, overview, devices] = await Promise.all([
          hubRequest<{ servers: HubServer[] }>(link, "/api/servers"),
          hubRequest<{ servers: HubOverview[] }>(
            link,
            `/api/overview${refresh ? "?refresh=1" : ""}`,
          ),
          hubRequest<{ devices: HubDevice[] }>(link, "/api/devices"),
        ]);
        setData({
          fetchedAt: Date.now(),
          device,
          servers: servers.servers,
          overviews: overview.servers,
          devices: devices.devices,
        });
        setError(null);
      } catch (cause) {
        const status = (cause as { status?: number }).status ?? 0;
        setError({ status, message: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    [link],
  );

  useFocusEffect(
    useCallback(() => {
      void load(false);
      const timer = setInterval(() => void load(false), 10_000);
      return () => clearInterval(timer);
    }, [load]),
  );

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load(true);
    setRefreshing(false);
  }, [load]);

  return { data, error, refreshing, refresh };
}

function FleetDashboard({ link }: { readonly link: HubLink }) {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { data, error, refreshing, refresh } = useFleetData(link);
  const { connectedEnvironments, connectPairingUrl } = useConnectionController();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [pushState, setPushState] = useState<string | null>(null);
  const now = data?.fetchedAt ?? 0;

  const summary = useMemo(
    () => (data ? summarizeFleet(data.servers, data.overviews) : null),
    [data],
  );
  const connectedIds = useMemo(
    () => new Set(connectedEnvironments.map((environment) => String(environment.environmentId))),
    [connectedEnvironments],
  );

  const ensureConnected = useCallback(
    async (row: FleetServerRow): Promise<boolean> => {
      if (row.environmentId && connectedIds.has(row.environmentId)) return true;
      setConnecting(row.server.id);
      try {
        const pairing = await hubRequest<{ pairingUrl: string }>(
          link,
          `/api/servers/${row.server.id}/pairing`,
          {},
        );
        const result = await connectPairingUrl(
          pairing.pairingUrl,
          (row.environmentId ?? undefined) as EnvironmentId | undefined,
        );
        if (AsyncResult.isFailure(result)) {
          Dialog.alert(
            "Could not connect",
            `Scope could not reach ${row.server.id} directly. Is Tailscale on?`,
          );
          return false;
        }
        return true;
      } catch (cause) {
        Dialog.alert("Could not connect", cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setConnecting(null);
      }
    },
    [connectPairingUrl, connectedIds, link],
  );

  const openThread = useCallback(
    async (thread: HubThread) => {
      const row = summary?.servers.find((candidate) => candidate.server.id === thread.serverId);
      if (!row?.environmentId) return;
      if (!(await ensureConnected(row))) return;
      navigation.navigate("Thread", {
        environmentId: row.environmentId,
        threadId: thread.threadId,
      } as never);
    },
    [ensureConnected, navigation, summary],
  );

  const openServer = useCallback(
    async (row: FleetServerRow) => {
      if (await ensureConnected(row)) navigation.navigate("Home" as never);
    },
    [ensureConnected, navigation],
  );

  const enablePush = async () => {
    try {
      const result = await registerPushWithHub(link);
      setPushState(
        result === "registered" ? "Push is on for this phone." : `Push not enabled (${result}).`,
      );
    } catch (cause) {
      setPushState(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const testPush = async () => {
    try {
      const result = await sendTestPush(link);
      setPushState(result.ok ? "Test push sent." : `Push failed: ${result.reason ?? "unknown"}`);
    } catch (cause) {
      setPushState(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const disconnect = () =>
    Dialog.confirm({
      title: "Disconnect from the hub?",
      message: "This phone forgets its hub token. Servers stay paired.",
      confirmText: "Disconnect",
      destructive: true,
      onConfirm: () => void forgetHub(),
    });

  if (error?.status === 401 || error?.status === 403) {
    if (data?.device.status !== "pending") {
      return (
        <CenteredMessage
          title="This phone was revoked"
          body={error.message}
          action={{ label: "Enroll again", onPress: () => void forgetHub() }}
        />
      );
    }
  }
  if (data?.device.status === "pending") {
    return (
      <CenteredMessage
        title="Waiting for approval"
        body={`Approve “${data.device.name}” from an enrolled phone, or run \`fleet-hub device approve ${data.device.id}\` on the hub.`}
        action={{ label: "Check again", onPress: () => void refresh() }}
        secondary={{ label: "Use a different hub", onPress: () => void forgetHub() }}
      />
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentContainerStyle={{
        paddingTop: insets.top + 16,
        paddingHorizontal: 16,
        paddingBottom: insets.bottom + 32,
        gap: 18,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      <View
        style={{ flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between" }}
      >
        <View>
          <Text className="text-4xl font-t3-bold text-foreground">Fleet</Text>
          <Text className="text-sm text-muted-foreground">
            {link.url.replace(/^https?:\/\//, "")}
          </Text>
        </View>
        <Button
          label="Workspace"
          tone="secondary"
          onPress={() => navigation.navigate("Home" as never)}
        />
      </View>

      {error ? (
        <GlassSurface style={{ padding: 14 }}>
          <Text className="text-sm text-destructive">{error.message}</Text>
        </GlassSurface>
      ) : null}

      {summary && summary.attention.length > 0 ? (
        <Section title="Needs you">
          {summary.attention.map((thread) => (
            <ThreadRow
              key={`${thread.serverId}:${thread.threadId}`}
              thread={thread}
              detail={thread.summary}
              accent
              now={now}
              onPress={() => void openThread(thread)}
            />
          ))}
        </Section>
      ) : null}

      <Section title="Servers">
        {summary === null ? (
          <Text className="text-sm text-muted-foreground">Loading…</Text>
        ) : summary.servers.length === 0 ? (
          <Text className="text-sm text-muted-foreground">
            No T3 servers are linked yet. Run scripts/fleet/install with --hub to add one.
          </Text>
        ) : (
          summary.servers.map((row) => (
            <ServerCard
              key={row.server.id}
              row={row}
              connected={row.environmentId !== null && connectedIds.has(row.environmentId)}
              connecting={connecting === row.server.id}
              onPress={() => void openServer(row)}
            />
          ))
        )}
      </Section>

      {summary && summary.recent.length > 0 ? (
        <Section title="Recent threads">
          {summary.recent.map((thread) => (
            <ThreadRow
              key={`${thread.serverId}:${thread.threadId}`}
              thread={thread}
              detail={thread.status ?? ""}
              now={now}
              onPress={() => void openThread(thread)}
            />
          ))}
        </Section>
      ) : null}

      {data ? (
        <Section title="Devices">
          {data.devices
            .filter((device) => device.status !== "revoked")
            .map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                self={device.id === link.deviceId}
                link={link}
                onChange={() => void refresh()}
              />
            ))}
        </Section>
      ) : null}

      <Section title="This phone">
        <GlassSurface style={{ padding: 14, gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            <Button label="Enable push" tone="secondary" onPress={() => void enablePush()} />
            <Button label="Test push" tone="secondary" onPress={() => void testPush()} />
            <Button label="Disconnect" tone="danger" onPress={disconnect} />
          </View>
          {pushState ? <Text className="text-sm text-muted-foreground">{pushState}</Text> : null}
        </GlassSurface>
      </Section>
    </ScrollView>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text className="px-1 text-xs font-t3-bold uppercase tracking-wider text-muted-foreground">
        {props.title}
      </Text>
      <View style={{ gap: 10 }}>{props.children}</View>
    </View>
  );
}

const HEALTH_COLOR = { online: "#34C759", error: "#FF453A", unlinked: "#8E8E93" } as const;

function ServerCard(props: {
  readonly row: FleetServerRow;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly onPress: () => void;
}) {
  const { row } = props;
  return (
    <Pressable
      onPress={props.onPress}
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.label}`}
    >
      <GlassSurface style={{ padding: 14, gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 5,
              backgroundColor: HEALTH_COLOR[row.health],
            }}
          />
          <Text className="flex-1 text-lg font-t3-bold text-foreground" numberOfLines={1}>
            {row.label}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {props.connecting ? "Connecting…" : props.connected ? "Connected" : "Tap to connect"}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {row.server.id} · {row.threads} threads
          {row.running > 0 ? ` · ${row.running} running` : ""}
          {row.waiting > 0 ? ` · ${row.waiting} waiting` : ""}
        </Text>
        {row.health === "error" && row.error ? (
          <Text className="text-xs text-destructive" numberOfLines={2}>
            {row.error}
          </Text>
        ) : null}
      </GlassSurface>
    </Pressable>
  );
}

function ThreadRow(props: {
  readonly thread: HubThread;
  readonly detail: string;
  readonly accent?: boolean;
  readonly now: number;
  readonly onPress: () => void;
}) {
  const { thread } = props;
  return (
    <Pressable onPress={props.onPress} accessibilityRole="button">
      <GlassSurface style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}>
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          {props.accent ? (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: "#FFB23E" }} />
          ) : null}
          <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
            {thread.title ?? "Untitled thread"}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {relativeTime(thread.updatedAt, props.now)}
          </Text>
        </View>
        <Text className="text-sm text-muted-foreground" numberOfLines={1}>
          {thread.serverId}
          {thread.projectTitle ? ` · ${thread.projectTitle}` : ""} · {props.detail}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

function DeviceRow(props: {
  readonly device: HubDevice;
  readonly self: boolean;
  readonly link: HubLink;
  readonly onChange: () => void;
}) {
  const { device, link } = props;
  const act = async (action: "approve" | "revoke") => {
    try {
      await hubRequest(link, `/api/devices/${device.id}/${action}`, {});
      props.onChange();
    } catch (cause) {
      Dialog.alert(
        "Could not update the device",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
  };
  return (
    <GlassSurface style={{ padding: 12, gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
          {device.name}
          {props.self ? " (this phone)" : ""}
        </Text>
        <Text className="text-xs text-muted-foreground">
          {device.role}
          {device.status === "pending" ? " · pending" : ""}
          {device.hasPush ? " · push" : ""}
        </Text>
      </View>
      {!props.self ? (
        <View style={{ flexDirection: "row", gap: 8 }}>
          {device.status === "pending" ? (
            <Button label="Approve" onPress={() => void act("approve")} />
          ) : null}
          <Button label="Revoke" tone="danger" onPress={() => void act("revoke")} />
        </View>
      ) : null}
    </GlassSurface>
  );
}

function CenteredMessage(props: {
  readonly title: string;
  readonly body: string;
  readonly action: { readonly label: string; readonly onPress: () => void };
  readonly secondary?: { readonly label: string; readonly onPress: () => void };
}) {
  return (
    <View className="flex-1 bg-screen" style={{ justifyContent: "center", padding: 24 }}>
      <GlassSurface style={{ padding: 20, gap: 14 }}>
        <Text className="text-2xl font-t3-bold text-foreground">{props.title}</Text>
        <Text className="text-base text-muted-foreground">{props.body}</Text>
        <Button label={props.action.label} onPress={props.action.onPress} fullWidth />
        {props.secondary ? (
          <Button
            label={props.secondary.label}
            tone="text"
            onPress={props.secondary.onPress}
            fullWidth
          />
        ) : null}
      </GlassSurface>
    </View>
  );
}
