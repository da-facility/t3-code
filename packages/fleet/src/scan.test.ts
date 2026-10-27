import { describe, expect, it } from "@effect/vitest";

import { parseScan } from "./scan.ts";

const OUTPUT = `@@fleet:uname
Linux
@@fleet:docker
[{"Name":"/rustdesk-hbbs","State":{"Status":"running"},"Config":{"Image":"rustdesk/rustdesk-server:1.1.11","Labels":{"com.docker.compose.project.working_dir":"/opt/rustdesk","com.docker.compose.project.config_files":"/opt/rustdesk/compose.yaml"}}},
 {"Name":"/scratch","State":{"Status":"exited"},"Config":{"Image":"alpine:3","Labels":null}}]
@@fleet:systemd
nginx.service loaded active running A high performance web server
systemd-journald.service loaded active running Journal Service
t3.service loaded inactive dead T3
apparmor.service loaded active exited Load AppArmor profiles
@@fleet:systemd-files
Id=nginx.service
FragmentPath=/usr/lib/systemd/system/nginx.service

Id=t3.service
FragmentPath=/etc/systemd/system/t3.service
@@fleet:end
`;

const MAC_OUTPUT = `@@fleet:uname
Darwin
@@fleet:brew
[{"name":"postgresql@16","status":"started","file":"~/Library/LaunchAgents/homebrew.mxcl.postgresql@16.plist"}]
@@fleet:launchd
/Library/LaunchDaemons/com.example.agent.plist
/Users/me/Library/LaunchAgents/com.apple.something.plist
@@fleet:launchd-list
PID Status Label
412 0 com.example.agent
@@fleet:end
`;

describe("parseScan", () => {
  it("reads docker compose metadata and admin systemd units", () => {
    const services = parseScan("host-a", OUTPUT, "2026-01-01T00:00:00Z");
    expect(services.find((service) => service.name === "rustdesk-hbbs")).toMatchObject({
      kind: "docker",
      status: "running",
      image: "rustdesk/rustdesk-server:1.1.11",
      composeDir: "/opt/rustdesk",
      configFiles: ["/opt/rustdesk/compose.yaml"],
    });
    expect(services.find((service) => service.name === "scratch")?.composeDir).toBeNull();
    const units = services.filter((service) => service.kind === "systemd").map((s) => s.name);
    expect(units).toEqual(["nginx", "t3"]);
  });

  it("reads brew services and non-Apple launchd jobs", () => {
    const services = parseScan("host-b", MAC_OUTPUT, "2026-01-01T00:00:00Z");
    expect(services.map((service) => [service.kind, service.name, service.status])).toEqual([
      ["brew", "postgresql@16", "started"],
      ["launchd", "com.example.agent", "running"],
    ]);
  });
});
