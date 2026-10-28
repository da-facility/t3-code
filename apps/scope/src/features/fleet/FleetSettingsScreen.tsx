import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { Section } from "./FleetScreen";
import { forgetMetaserver, type MetaserverLink, useMetaserverLink } from "./metaserverClient";
import { registerPushWithMetaserver, sendTestPush } from "./push";

/** Settings → Metaserver & push: this phone's metaserver connection and its notifications. */
export function FleetSettingsScreen() {
  const link = useMetaserverLink();
  if (link === undefined) return <View className="flex-1 bg-screen" />;
  if (link === null) {
    return (
      <View className="flex-1 bg-screen" style={{ padding: 24 }}>
        <Text className="text-base text-foreground-muted">
          This phone is not connected to a metaserver. Connect from the Fleet tab.
        </Text>
      </View>
    );
  }
  return <FleetSettings link={link} />;
}

function FleetSettings({ link }: { readonly link: MetaserverLink }) {
  const [pushState, setPushState] = useState<string | null>(null);

  const enablePush = () => {
    void registerPushWithMetaserver(link).then(
      (result) =>
        setPushState(
          result === "registered" ? "Push is on for this phone." : `Push not enabled (${result}).`,
        ),
      (cause: unknown) => setPushState(describe(cause)),
    );
  };

  const testPush = () => {
    void sendTestPush(link).then(
      (result) =>
        setPushState(result.ok ? "Test push sent." : `Push failed: ${result.reason ?? "unknown"}`),
      (cause: unknown) => setPushState(describe(cause)),
    );
  };

  const disconnect = () =>
    Dialog.confirm({
      title: "Disconnect from the metaserver?",
      message: "This phone forgets its metaserver token. Servers stay paired.",
      confirmText: "Disconnect",
      destructive: true,
      onConfirm: () => void forgetMetaserver(),
    });

  return (
    <ScrollView
      className="flex-1 bg-screen"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 18 }}
    >
      <Section title="Metaserver">
        <GlassSurface style={{ padding: 14 }}>
          <Text className="text-base text-foreground" selectable>
            {link.url.replace(/^https?:\/\//, "")}
          </Text>
        </GlassSurface>
      </Section>
      <Section title="Push">
        <GlassSurface style={{ padding: 14, gap: 10 }}>
          <View style={{ flexDirection: "row", gap: 10, flexWrap: "wrap" }}>
            <Button label="Enable push" tone="secondary" onPress={enablePush} />
            <Button label="Test push" tone="secondary" onPress={testPush} />
          </View>
          {pushState ? <Text className="text-sm text-foreground-muted">{pushState}</Text> : null}
        </GlassSurface>
      </Section>
      <Section title="This phone">
        <View style={{ flexDirection: "row" }}>
          <Button label="Disconnect from metaserver" tone="danger" onPress={disconnect} />
        </View>
      </Section>
    </ScrollView>
  );
}

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
