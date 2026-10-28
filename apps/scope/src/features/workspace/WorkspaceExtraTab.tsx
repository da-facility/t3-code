import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { FleetScreen } from "../fleet/FleetScreen";
import { UsageRouteScreen } from "../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "fleet" ? <FleetScreen /> : <UsageRouteScreen workspace />}
    </>
  );
}
