#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type { RegistryServerInput } from "@t3tools/fleet/registry";

import { ApnsSender } from "./apns.ts";
import { HubDb } from "./db.ts";
import { Fleet } from "./fleet.ts";
import { createHubServer } from "./http.ts";
import { scanServer } from "./scanner.ts";
import { OpCli } from "./vault/op.ts";
import { vaultRoutes } from "./vault/routes.ts";
import { Vault } from "./vault/vault.ts";
import { Watcher, type PushFn } from "./watcher.ts";

const USAGE = `fleet-hub <command>

  serve                                   Run the hub (HTTP API, fleet MCP, watcher)
  server add <id> --address A [--user U] [--port N] [--key-name K] [--tag T]... [--t3-url URL]
  server import                           Upsert servers from a JSON array on stdin
  server list [--json]
  server remove <id>
  link <id> --url <t3-url>                Link a T3 server; reads {"bearer","mcp"} JSON on stdin
  unlink <id>
  token issue --label L [--server id]     Issue a fleet MCP token (printed once)
  token list | token revoke <id>
  scan [<id>...] [--all]                  Scan hosts over SSH with the hub's key
  pubkey                                  Print the hub's SSH public key (creates it once)
  device list | device approve <id> | device revoke <id>
  overview [--json]                       Threads and pending requests across linked servers
  call <server> <tool> [json-args]        Call a T3 tool on a linked server
  vault setup [--account A]               Store the 1Password master password (read from stdin)
  vault status | vault lock | vault reset
  vault recover                           Re-wrap the vault key for enrolled phones (code on stdin)
  vault request <url>                     Ask the phone to approve a credential (testing)

Environment: FLEET_HUB_HOME (default /var/lib/fleet-hub), FLEET_HUB_HOST, FLEET_HUB_PORT (8780),
FLEET_HUB_OP_BIN (default op), FLEET_HUB_OP_ACCOUNT (op account shorthand).
APNs: put {"keyPath","keyId","teamId","topic"} in $FLEET_HUB_HOME/apns.json.`;

const home = process.env.FLEET_HUB_HOME ?? "/var/lib/fleet-hub";
const paths = {
  db: NodePath.join(home, "hub.sqlite"),
  sshKey: NodePath.join(home, "ssh", "id_ed25519"),
  knownHosts: NodePath.join(home, "ssh", "known_hosts"),
  apns: NodePath.join(home, "apns.json"),
};

function openDb() {
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new HubDb(paths.db);
  NodeFS.chmodSync(paths.db, 0o600);
  return db;
}

const readStdin = () => NodeFS.readFileSync(0, "utf8");

function ensureSshKey() {
  if (!NodeFS.existsSync(paths.sshKey)) {
    NodeFS.mkdirSync(NodePath.dirname(paths.sshKey), { recursive: true, mode: 0o700 });
    NodeChildProcess.execFileSync(
      "ssh-keygen",
      ["-t", "ed25519", "-N", "", "-C", "fleet-hub", "-f", paths.sshKey],
      { stdio: "ignore" },
    );
  }
  return NodeFS.readFileSync(`${paths.sshKey}.pub`, "utf8").trim();
}

function loadPush(): PushFn | null {
  if (!NodeFS.existsSync(paths.apns)) return null;
  const config = JSON.parse(NodeFS.readFileSync(paths.apns, "utf8")) as {
    keyPath: string;
    keyId: string;
    teamId: string;
    topic: string;
  };
  const keyPem = NodeFS.readFileSync(config.keyPath, "utf8");
  const senders = {
    production: new ApnsSender({ ...config, keyPem, origin: "https://api.push.apple.com" }),
    sandbox: new ApnsSender({ ...config, keyPem, origin: "https://api.sandbox.push.apple.com" }),
  };
  return (token, environment, message) =>
    (environment === "production" ? senders.production : senders.sandbox).send(token, message);
}

function makeVault(
  db: HubDb,
  push: PushFn | null,
  account: string | null = process.env.FLEET_HUB_OP_ACCOUNT ?? null,
) {
  return new Vault(db, new OpCli(process.env.FLEET_HUB_OP_BIN ?? "op", account), {
    notify: (request, locked) => {
      if (!push) return;
      for (const device of db.listDevices()) {
        if (device.status !== "approved" || !device.apnsToken) continue;
        void push(device.apnsToken, device.apnsEnv, {
          title: locked ? "Unlock to sign in" : "Approve sign-in",
          body: `${request.requester} wants your login for ${new URL(request.url).host}`,
          timeSensitive: true,
          data: { kind: "credential", requestId: request.id },
        });
      }
    },
  });
}

async function admin(path: string, body: unknown) {
  const port = Number(process.env.FLEET_HUB_PORT ?? 8780);
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  const json = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json;
}

const print = (value: unknown) =>
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

async function main(argv: string[]) {
  const [command, ...rest] = argv;
  const { values, positionals } = NodeUtil.parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      address: { type: "string" },
      user: { type: "string" },
      port: { type: "string" },
      "key-name": { type: "string" },
      tag: { type: "string", multiple: true },
      "t3-url": { type: "string" },
      url: { type: "string" },
      label: { type: "string" },
      server: { type: "string" },
      all: { type: "boolean" },
      json: { type: "boolean" },
      account: { type: "string" },
    },
  });

  switch (command) {
    case "serve": {
      const db = openDb();
      ensureSshKey();
      const fleet = new Fleet(db);
      const push = loadPush();
      const watcher = new Watcher(db, fleet, push ?? (async () => ({ ok: true })));
      const vault = makeVault(db, push);
      const server = createHubServer({
        db,
        fleet,
        push,
        extraRoutes: vaultRoutes(db, vault),
        requestCredential: async (url, requester) => {
          const credential = await vault.requestCredential(url, requester);
          return credential
            ? {
                title: credential.title,
                username: credential.username,
                password: credential.password,
              }
            : null;
        },
        onDeviceRevoked: (deviceId) => vault.onDeviceRevoked(deviceId),
        adminRoutes: async (path, body) => {
          const input = body as { url?: string };
          if (path === "/admin/vault/status") return vault.status();
          if (path === "/admin/vault/lock")
            return vault.lock("operator").then(() => vault.status());
          if (path === "/admin/vault/request" && input.url) {
            const credential = await vault.requestCredential(input.url, "fleet-hub cli");
            return credential
              ? {
                  approved: true,
                  title: credential.title,
                  username: credential.username,
                  password: credential.password ? "<redacted>" : null,
                }
              : { approved: false };
          }
          if (
            path === "/admin/device-revoked" &&
            typeof (body as { id?: string }).id === "string"
          ) {
            vault.onDeviceRevoked((body as { id: string }).id);
            return { ok: true };
          }
          throw new Error("Unknown admin route");
        },
      });
      const host = process.env.FLEET_HUB_HOST ?? "0.0.0.0";
      const port = Number(process.env.FLEET_HUB_PORT ?? 8780);
      server.listen(port, host, () => {
        console.log(`fleet-hub listening on ${host}:${port} (push ${push ? "on" : "off"})`);
      });
      watcher.start(Number(process.env.FLEET_HUB_POLL_MS ?? 15_000));
      const shutdown = () => {
        watcher.stop();
        server.close(() => {
          db.close();
          process.exit(0);
        });
        setTimeout(() => process.exit(0), 3000).unref();
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
      return;
    }

    case "server": {
      const db = openDb();
      const [sub, id] = positionals;
      if (sub === "add") {
        if (!id || !values.address) throw new Error("server add <id> --address <host>");
        const input: RegistryServerInput = {
          id,
          address: values.address,
          ...(values.user !== undefined ? { user: values.user } : {}),
          ...(values.port !== undefined ? { port: Number(values.port) } : {}),
          ...(values["key-name"] !== undefined ? { keyName: values["key-name"] } : {}),
          ...(values.tag ? { tags: values.tag } : {}),
          ...(values["t3-url"] !== undefined ? { t3Url: values["t3-url"] } : {}),
          sources: ["manual"],
        };
        return print(db.upsertServer(input));
      }
      if (sub === "import") {
        const rows = JSON.parse(readStdin()) as RegistryServerInput[];
        for (const row of rows) db.upsertServer(row);
        return print(`Imported ${rows.length} servers.`);
      }
      if (sub === "list") {
        const fleet = new Fleet(db);
        const servers = fleet.describeServers();
        if (values.json) return print(servers);
        for (const server of servers) {
          console.log(
            `${server.id.padEnd(24)} ${server.ssh.padEnd(40)} ${server.t3.linked ? "t3:linked" : server.t3.url ? "t3:unlinked" : "-"}  services:${server.serviceCount}  ${server.tags.join(",")}`,
          );
        }
        return;
      }
      if (sub === "remove" && id)
        return print(db.removeServer(id) ? "Removed." : "No such server.");
      throw new Error(USAGE);
    }

    case "link": {
      const [id] = positionals;
      if (!id || !values.url)
        throw new Error('link <id> --url <t3-url>  (stdin: {"bearer","mcp"})');
      const credentials = JSON.parse(readStdin()) as { bearer?: string; mcp?: string };
      if (!credentials.bearer || !credentials.mcp)
        throw new Error("stdin must carry bearer and mcp tokens");
      const db = openDb();
      if (!db.getServer(id))
        db.upsertServer({ id, address: new URL(values.url).hostname, sources: ["manual"] });
      db.setLink(id, values.url, credentials.bearer, credentials.mcp);
      const fleet = new Fleet(db);
      const environment = await fleet.verifyLink(id);
      return print({
        linked: id,
        url: values.url,
        environmentId: environment.environmentId,
        serverVersion: environment.serverVersion,
      });
    }

    case "unlink": {
      const [id] = positionals;
      const db = openDb();
      return print(id && db.removeLink(id) ? "Unlinked." : "No such link.");
    }

    case "token": {
      const db = openDb();
      const [sub, id] = positionals;
      if (sub === "issue") {
        const issued = db.issueToken(values.label ?? "fleet", values.server ?? null);
        return print(values.json ? issued : issued.token);
      }
      if (sub === "list") return print(db.listTokens());
      if (sub === "revoke" && id) return print(db.revokeToken(id) ? "Revoked." : "No such token.");
      throw new Error(USAGE);
    }

    case "pubkey":
      return print(ensureSshKey());

    case "scan": {
      const db = openDb();
      ensureSshKey();
      const targets = values.all
        ? db.listServers()
        : positionals.map((id) => db.getServer(id)).filter((s) => s !== null);
      if (targets.length === 0) throw new Error("scan <id>... or scan --all");
      for (const server of targets) {
        print(
          await scanServer(db, server, {
            identityFile: paths.sshKey,
            knownHostsFile: paths.knownHosts,
          }),
        );
      }
      return;
    }

    case "device": {
      const db = openDb();
      const [sub, id] = positionals;
      if (sub === "list")
        return print(
          db
            .listDevices()
            .map(({ apnsToken, ...device }) => ({ ...device, push: apnsToken !== null })),
        );
      if (sub === "approve" && id)
        return print(db.approveDevice(id, "cli") ? "Approved." : "No pending device with that id.");
      if (sub === "revoke" && id)
        return print(db.revokeDevice(id) ? "Revoked." : "No such device.");
      throw new Error(USAGE);
    }

    case "overview": {
      const db = openDb();
      const overviews = await new Fleet(db).overviewAll();
      if (values.json) return print(overviews);
      for (const overview of overviews) {
        console.log(`${overview.serverId}: ${overview.ok ? "ok" : `error: ${overview.error}`}`);
        for (const thread of overview.threads)
          console.log(`  [${thread.status}] ${thread.title ?? thread.threadId}`);
        for (const request of overview.pending)
          console.log(`  ! ${request.threadTitle}: ${request.summary}`);
      }
      return;
    }

    case "vault": {
      const [sub] = positionals;
      if (sub === "setup") {
        const db = openDb();
        const password = readStdin().replace(/\r?\n$/, "");
        if (!password) throw new Error("Pipe the 1Password master password on stdin.");
        const vault = makeVault(
          db,
          null,
          values.account ?? process.env.FLEET_HUB_OP_ACCOUNT ?? null,
        );
        const result = await vault.setup(
          password,
          values.account ?? process.env.FLEET_HUB_OP_ACCOUNT ?? null,
        );
        console.log("Vault ready. Recovery code (shown once; save it in 1Password and offline):\n");
        console.log(`  ${result.recoveryCode}\n`);
        console.log(`Vault key wrapped for ${result.wrappedFor.length} phone(s) with a key.`);
        return;
      }
      if (sub === "recover") {
        const db = openDb();
        const result = await makeVault(db, null).recover(readStdin().trim());
        return print(`Vault key re-wrapped for ${result.wrappedFor.length} phone(s).`);
      }
      if (sub === "reset") {
        const db = openDb();
        makeVault(db, null).reset();
        return print("Vault removed. Run `vault setup` again; old recovery codes no longer work.");
      }
      if (sub === "status" || sub === "lock") return print(await admin(`/admin/vault/${sub}`, {}));
      if (sub === "request" && positionals[1])
        return print(await admin("/admin/vault/request", { url: positionals[1] }));
      throw new Error(USAGE);
    }

    case "call": {
      const [server, tool, args] = positionals;
      if (!server || !tool) throw new Error("call <server> <tool> [json-args]");
      const db = openDb();
      return print(
        await new Fleet(db).call(
          server,
          tool,
          args ? (JSON.parse(args) as Record<string, unknown>) : {},
        ),
      );
    }

    default:
      console.log(USAGE);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
