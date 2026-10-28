#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - A one-off CLI around pure parsers.
// One-off registry import. Reads this machine's ~/.ssh/config, `tailscale status --json` and
// any Ansible INI inventories you name, merges them and pipes the rows to the metaserver over SSH.
// Nothing is written locally. Preview with --dry-run (prints the rows).
//
//   node scripts/fleet/import-registry.ts --metaserver <ssh-target> [--inventory path]... [--dry-run]
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import {
  mergeImported,
  parseAnsibleIni,
  parseSshConfig,
  parseTailscaleStatus,
} from "@t3tools/fleet/importers";

const { values } = NodeUtil.parseArgs({
  options: {
    metaserver: { type: "string" },
    inventory: { type: "string", multiple: true },
    "dry-run": { type: "boolean" },
    "no-tailscale": { type: "boolean" },
  },
});

const sshConfigPath = NodePath.join(NodeOS.homedir(), ".ssh", "config");
const sshServers = NodeFS.existsSync(sshConfigPath)
  ? parseSshConfig(NodeFS.readFileSync(sshConfigPath, "utf8"))
  : [];

let tailscaleServers: ReturnType<typeof parseTailscaleStatus> = [];
if (!values["no-tailscale"]) {
  for (const bin of ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"]) {
    try {
      const json = NodeChildProcess.execFileSync(bin, ["status", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      tailscaleServers = parseTailscaleStatus(json);
      break;
    } catch {}
  }
}

const ansibleServers = (values.inventory ?? []).flatMap((path) =>
  parseAnsibleIni(NodeFS.readFileSync(path, "utf8")),
);

const rows = mergeImported(sshServers, tailscaleServers, ansibleServers);
console.error(
  `ssh config: ${sshServers.length}, tailscale: ${tailscaleServers.length}, ansible: ${ansibleServers.length} -> ${rows.length} servers`,
);

if (values["dry-run"] || !values.metaserver) {
  console.log(JSON.stringify(rows, null, 2));
  if (!values.metaserver && !values["dry-run"])
    console.error("Pass --metaserver <ssh-target> to import.");
} else {
  NodeChildProcess.execFileSync("ssh", [values.metaserver, "t3-metaserver", "server", "import"], {
    input: JSON.stringify(rows),
    stdio: ["pipe", "inherit", "inherit"],
  });
}
