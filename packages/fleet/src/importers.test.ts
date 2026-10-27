import { describe, expect, it } from "@effect/vitest";

import {
  mergeImported,
  parseAnsibleIni,
  parseSshConfig,
  parseTailscaleStatus,
} from "./importers.ts";

const SSH_CONFIG = `
Host *
  ServerAliveInterval 30

Host host-a host-a-alias
  HostName 100.64.0.1
  User deploy
  Port 2222
  IdentityFile ~/.ssh/fleet_key

Match host foo
  User ignored

Host host-b
  HostName host-b.example.ts.net
`;

const TAILSCALE = JSON.stringify({
  Self: { HostName: "laptop" },
  Peer: {
    a: { HostName: "host-b", DNSName: "host-b.example.ts.net.", OS: "linux", Tags: ["tag:server"] },
    b: { HostName: "phone", DNSName: "phone.example.ts.net.", OS: "iOS" },
    c: { HostName: "host-c", DNSName: "host-c.example.ts.net.", OS: "macOS" },
  },
});

const ANSIBLE = `
[web]
host-c ansible_user=admin ansible_ssh_private_key_file=/keys/ops_key
host-a

[db]
host-c

[web:vars]
foo=bar
`;

describe("registry importers", () => {
  it("parses concrete ssh hosts and skips wildcard and match blocks", () => {
    const servers = parseSshConfig(SSH_CONFIG);
    expect(servers.map((server) => server.id)).toEqual(["host-a", "host-a-alias", "host-b"]);
    expect(servers[0]).toMatchObject({
      address: "100.64.0.1",
      user: "deploy",
      port: 2222,
      keyName: "fleet_key",
    });
    expect(servers[2]).toMatchObject({ address: "host-b.example.ts.net", user: null, port: 22 });
  });

  it("parses tailscale peers and skips phones", () => {
    const servers = parseTailscaleStatus(TAILSCALE);
    expect(servers.map((server) => server.id)).toEqual(["host-b", "host-c"]);
    expect(servers[0]!.tags).toEqual(["linux", "server"]);
    expect(servers[0]!.address).toBe("host-b.example.ts.net");
  });

  it("turns ansible groups into tags", () => {
    const servers = parseAnsibleIni(ANSIBLE);
    expect(servers.find((server) => server.id === "host-c")).toMatchObject({
      user: "admin",
      keyName: "ops_key",
      tags: ["web", "db"],
    });
  });

  it("merges rows for the same machine, first source winning", () => {
    const merged = mergeImported(
      parseSshConfig(SSH_CONFIG),
      parseTailscaleStatus(TAILSCALE),
      parseAnsibleIni(ANSIBLE),
    );
    const hostB = merged.find((server) => server.id === "host-b");
    expect(hostB?.sources).toEqual(["ssh-config", "tailscale"]);
    expect(hostB?.tags).toEqual(["linux", "server"]);
    const hostC = merged.find((server) => server.id === "host-c");
    expect(hostC?.sources).toEqual(["tailscale", "ansible"]);
    expect(hostC?.user).toBe("admin");
    const hostA = merged.find((server) => server.id === "host-a");
    expect(hostA?.tags).toEqual(["web"]);
  });
});
