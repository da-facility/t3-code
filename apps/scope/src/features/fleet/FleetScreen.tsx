import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import * as Clipboard from "expo-clipboard";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, View } from "react-native";

import { AppText as Text, AppTextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useConnectionController } from "../connection/useConnectionController";
import { openSettings } from "../settings/settings-navigation";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { useSelectWorkspaceTab } from "../workspace/useSelectWorkspaceTab";
import {
  type FleetServerRow,
  type MetaserverDevice,
  type MetaserverOverview,
  type MetaserverServer,
  type MetaserverThread,
  isServerConnected,
  normalizeMetaserverUrl,
  summarizeFleet,
} from "./fleetModel";
import {
  enrollWithMetaserver,
  forgetMetaserver,
  type MetaserverLink,
  metaserverRequest,
  moveToBuildMetaserver,
  loadMetaserverLink,
  useMetaserverLink,
} from "./metaserverClient";
import { moveServersOntoRelay, pairThroughMetaserver } from "./relayConnection";
import { scopeVault } from "./vaultNative";

/**
 * The Fleet tab: servers, controllers and the rest of the registry, through the metaserver.
 * Tapping a server pairs this phone with it through the metaserver's relay and opens it
 * in the Workspace tab.
 */
export function FleetScreen() {
  const link = useMetaserverLink();
  if (link === undefined) return <View className="flex-1 bg-screen" />;
  if (link === null) return <MetaserverSetup />;
  return <FleetDashboard link={link} />;
}

const defaultMetaserverUrl =
  (Constants.expoConfig?.extra as { defaultMetaserverUrl?: string | null } | undefined)
    ?.defaultMetaserverUrl ?? "";

function MetaserverSetup() {
  const [url, setUrl] = useState(defaultMetaserverUrl);
  const [name, setName] = useState(Device.deviceName ?? "iPhone");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const enroll = async () => {
    const normalized = normalizeMetaserverUrl(url);
    if (!normalized) {
      setError("Enter the metaserver's tailnet address, like metaserver.example.ts.net.");
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await enrollAndRegisterKey(normalized, name.trim() || "iPhone");
    setError(failure);
    setBusy(false);
  };

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingTop: 24,
        paddingHorizontal: 20,
        paddingBottom: 40,
        gap: 20,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <View style={{ gap: 6 }}>
        <Text className="text-4xl font-t3-bold text-foreground">Scope</Text>
        <Text className="text-base text-foreground-muted">
          Connect to your t3 metaserver over Tailscale. The first phone becomes the owner; later
          phones are approved from an enrolled one.
        </Text>
      </View>
      <GlassSurface style={{ padding: 16, gap: 12 }}>
        <Text className="text-sm font-t3-medium text-foreground-muted">Metaserver address</Text>
        <AppTextInput
          className="rounded-xl border border-border px-3 py-3 text-base text-foreground"
          value={url}
          onChangeText={setUrl}
          placeholder="metaserver.example.ts.net"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          accessibilityLabel="Metaserver address"
        />
        <Text className="text-sm font-t3-medium text-foreground-muted">This phone's name</Text>
        <AppTextInput
          className="rounded-xl border border-border px-3 py-3 text-base text-foreground"
          value={name}
          onChangeText={setName}
          accessibilityLabel="Device name"
        />
        {error ? <Text className="text-sm text-danger-foreground">{error}</Text> : null}
        <Button
          label="Connect to metaserver"
          onPress={() => void enroll()}
          loading={busy}
          fullWidth
        />
      </GlassSurface>
    </ScrollView>
  );
}

interface FleetData {
  fetchedAt: number;
  device: MetaserverDevice;
  servers: MetaserverServer[];
  overviews: MetaserverOverview[];
  devices: MetaserverDevice[];
}

function useFleetData(link: MetaserverLink) {
  const [data, setData] = useState<FleetData | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(
    async (refresh: boolean) => {
      const result = await fetchFleet(link, refresh);
      if ("error" in result) setError(result.error);
      else {
        setData(result.data);
        setError(null);
        moveServersOntoRelay(link, result.data.servers, result.data.overviews);
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

function FleetDashboard({ link }: { readonly link: MetaserverLink }) {
  const navigation = useNavigation();
  const workspace = useWorkspaceTabs();
  const selectTab = useSelectWorkspaceTab();
  const { data, error, refreshing, refresh } = useFleetData(link);
  const { connectedEnvironments } = useConnectionController();
  const [connecting, setConnecting] = useState<string | null>(null);

  const summary = useMemo(
    () => (data ? summarizeFleet(data.servers, data.overviews) : null),
    [data],
  );
  const ensureConnected = useCallback(
    async (row: FleetServerRow): Promise<boolean> => {
      if (isServerConnected(row, connectedEnvironments)) return true;
      setConnecting(row.server.id);
      const failure = await pairThroughMetaserver(link, row);
      setConnecting(null);
      if (failure) Dialog.alert("Could not connect", failure);
      return failure === null;
    },
    [connectedEnvironments, link],
  );

  const openThread = useCallback(
    async (thread: MetaserverThread) => {
      const row = summary?.servers.find((candidate) => candidate.server.id === thread.serverId);
      if (!row?.environmentId) return;
      if (!(await ensureConnected(row))) return;
      navigation.dispatch(
        StackActions.push("Thread", {
          environmentId: row.environmentId,
          threadId: thread.threadId,
        }),
      );
    },
    [ensureConnected, navigation, summary],
  );

  const openServer = useCallback(
    async (row: FleetServerRow) => {
      if (await ensureConnected(row)) selectTab("threads");
    },
    [ensureConnected, selectTab],
  );

  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, string | undefined>;
      if (data.kind === "credential") {
        openSettings(navigation, "SettingsVault");
        return;
      }
      const thread =
        data.serverId && data.threadId
          ? [...(summary?.attention ?? []), ...(summary?.recent ?? [])].find(
              (candidate) =>
                candidate.serverId === data.serverId && candidate.threadId === data.threadId,
            )
          : undefined;
      if (thread) void openThread(thread);
    });
    return () => subscription.remove();
  }, [navigation, openThread, summary]);

  if (error?.status === 401 || error?.status === 403) {
    if (data?.device.status !== "pending") {
      return (
        <CenteredMessage
          title="This phone was revoked"
          body={error.message}
          action={{ label: "Enroll again", onPress: () => void forgetMetaserver() }}
        />
      );
    }
  }
  if (data?.device.status === "pending") {
    return (
      <CenteredMessage
        title="Waiting for approval"
        body={`Approve “${data.device.name}” from an enrolled phone, or run \`t3-metaserver device approve ${data.device.id}\` on the metaserver.`}
        action={{ label: "Check again", onPress: () => void refresh() }}
        secondary={{ label: "Use a different metaserver", onPress: () => void forgetMetaserver() }}
      />
    );
  }

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        paddingTop: 8,
        paddingHorizontal: 16,
        paddingBottom: Math.max(32, workspace?.bottomClearance ?? 0),
        gap: 18,
      }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
    >
      {error ? (
        <GlassSurface style={{ padding: 14 }}>
          <Text className="text-sm text-danger-foreground">{error.message}</Text>
        </GlassSurface>
      ) : null}

      <Section title="Servers">
        {summary === null ? (
          <Text className="text-sm text-foreground-muted">Loading…</Text>
        ) : summary.servers.length === 0 ? (
          <Text className="text-sm text-foreground-muted">
            No T3 servers are linked yet. Run scripts/fleet/install with --metaserver to add one.
          </Text>
        ) : (
          summary.servers.map((row) => (
            <ServerCard
              key={row.server.id}
              row={row}
              connected={isServerConnected(row, connectedEnvironments)}
              connecting={connecting === row.server.id}
              onPress={() => void openServer(row)}
            />
          ))
        )}
      </Section>

      {data ? (
        <Section title="Controllers">
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

      {summary && summary.others.length > 0 ? (
        <Section title="Other servers">
          {summary.others.map((server) => (
            <OtherServerRow key={server.id} server={server} />
          ))}
        </Section>
      ) : null}
    </ScrollView>
  );
}

export function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text className="px-1 text-xs font-t3-bold uppercase tracking-wider text-foreground-muted">
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
          <Text className="text-xs text-foreground-muted">
            {props.connecting ? "Connecting…" : props.connected ? "Connected" : "Tap to connect"}
          </Text>
        </View>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {row.server.id} · {row.threads} threads
          {row.running > 0 ? ` · ${row.running} running` : ""}
          {row.waiting > 0 ? ` · ${row.waiting} waiting` : ""}
        </Text>
        {row.health === "error" && row.error ? (
          <Text className="text-xs text-danger-foreground" numberOfLines={2}>
            {row.error}
          </Text>
        ) : null}
      </GlassSurface>
    </Pressable>
  );
}

/** A registry server without T3. Tapping copies its SSH command. */
function OtherServerRow(props: { readonly server: MetaserverServer }) {
  const { server } = props;
  return (
    <Pressable
      onPress={() => void Clipboard.setStringAsync(`ssh ${server.ssh}`)}
      accessibilityRole="button"
      accessibilityLabel={`Copy the SSH command for ${server.id}`}
    >
      <GlassSurface style={{ paddingVertical: 12, paddingHorizontal: 14, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text className="flex-1 text-base font-t3-medium text-foreground" numberOfLines={1}>
            {server.id}
          </Text>
          {server.serviceCount > 0 ? (
            <Text className="text-xs text-foreground-muted">{server.serviceCount} services</Text>
          ) : null}
        </View>
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          ssh {server.ssh}
        </Text>
      </GlassSurface>
    </Pressable>
  );
}

function DeviceRow(props: {
  readonly device: MetaserverDevice;
  readonly self: boolean;
  readonly link: MetaserverLink;
  readonly onChange: () => void;
}) {
  const { device, link } = props;
  const act = async (action: "approve" | "revoke") => {
    try {
      await metaserverRequest(link, `/api/devices/${device.id}/${action}`, {});
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
        <Text className="text-xs text-foreground-muted">
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
        <Text className="text-base text-foreground-muted">{props.body}</Text>
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

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// Async work lives outside components: React Compiler cannot compile try/finally in them.

/** Enrolls, and registers the vault key at once when this phone became the owner. */
async function enrollAndRegisterKey(url: string, name: string): Promise<string | null> {
  try {
    const device = await enrollWithMetaserver(url, name);
    // Later phones register their key from the Vault screen once approved.
    if (device.status === "approved" && scopeVault) {
      const publicKey = await scopeVault.ensureKey();
      const link = await loadMetaserverLink();
      if (link) await metaserverRequest(link, "/api/vault/key", { publicKey }).catch(() => {});
    }
    return null;
  } catch (cause) {
    return describe(cause);
  }
}

async function fetchFleet(
  link: MetaserverLink,
  refresh: boolean,
): Promise<{ data: FleetData } | { error: { status: number; message: string } }> {
  try {
    const { device } = await metaserverRequest<{ device: MetaserverDevice }>(link, "/api/me");
    if (device.status !== "approved") {
      return { data: { fetchedAt: Date.now(), device, servers: [], overviews: [], devices: [] } };
    }
    const [servers, overview, devices] = await Promise.all([
      metaserverRequest<{ servers: MetaserverServer[] }>(link, "/api/servers"),
      metaserverRequest<{ servers: MetaserverOverview[] }>(
        link,
        `/api/overview${refresh ? "?refresh=1" : ""}`,
      ),
      metaserverRequest<{ devices: MetaserverDevice[] }>(link, "/api/devices"),
    ]);
    return {
      data: {
        fetchedAt: Date.now(),
        device,
        servers: servers.servers,
        overviews: overview.servers,
        devices: devices.devices,
      },
    };
  } catch (cause) {
    const status = (cause as { status?: number }).status ?? 0;
    // A saved address that stopped answering may be a renamed metaserver; the link store
    // re-renders with the build's address when the move works.
    if (status === 0)
      await moveToBuildMetaserver(link, normalizeMetaserverUrl(defaultMetaserverUrl));
    return { error: { status, message: describe(cause) } };
  }
}
