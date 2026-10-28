import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";
import { Platform } from "react-native";
import {
  NAVIGATION_TAB_LABELS,
  navigationCustomizationAvailable,
  resolveHiddenNavigationTabs,
  enabledNavigationTabs,
  type NavigationTab,
} from "./navigation-tab-order";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { mobilePreferencesAtom } from "../../state/preferences";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { resolveWorkspaceTabOrder } from "./workspace-tabs-state";

export const WORKSPACE_TAB_LABELS = {
  ...NAVIGATION_TAB_LABELS,
  ...(Platform.OS === "ios" ? { pullRequests: "PRs" } : {}),
};

export const NAVIGATION_TAB_ICONS = {
  fleet: "server.rack",
  threads: "text.bubble",
  pullRequests: PullRequestGlyph.pullRequest,
  usage: "chart.bar.xaxis",
} as const satisfies Readonly<Record<NavigationTab, AppSymbolName>>;

export function useNavigationTabOrder() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.navigationTabOrder
    : undefined;
  return useMemo(() => resolveWorkspaceTabOrder(saved), [saved]);
}

// Scope's tab bar is Fleet, Workspace and Settings.
const SCOPE_HIDDEN_TABS: readonly NavigationTab[] = ["pullRequests", "usage"];

export function useHiddenNavigationTabs() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const saved = AsyncResult.isSuccess(preferences)
    ? preferences.value.hiddenNavigationTabs
    : undefined;
  return useMemo(
    () =>
      navigationCustomizationAvailable()
        ? [...new Set([...resolveHiddenNavigationTabs(saved), ...SCOPE_HIDDEN_TABS])]
        : SCOPE_HIDDEN_TABS,
    [saved],
  );
}

export function useEnabledNavigationTabs() {
  const order = useNavigationTabOrder();
  const hidden = useHiddenNavigationTabs();
  return useMemo(() => enabledNavigationTabs(order, hidden), [order, hidden]);
}
