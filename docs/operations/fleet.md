# Fleet: metaserver, installer, Scope and vault

This fork runs T3 servers on many hosts, coordinated by the t3 metaserver on a small cloud server that is reachable only over Tailscale. The metaserver reaches each T3 server through its t3 client, and Scope, the metaclient on your phone, talks to the metaserver. `TODO.md` holds the decisions; this page is how to operate it. Use placeholders like `host-a` and `metaserver.example.ts.net` when you write about it here.

## Pieces

| Piece                               | Where      | What it does                                                                                            |
| ----------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `t3` (fork build)                   | every host | The t3 server, built by `.github/workflows/fleet-release.yml` as `<upstream>-fleet.<n>`                 |
| `scripts/fleet/install`             | your Mac   | Installs or updates `t3` on a host over SSH, links it to the metaserver, gives its agents the fleet MCP |
| `apps/metaserver` (`t3-metaserver`) | the VPS    | The t3 metaserver: registry, t3 client, fleet MCP (`/mcp`), phone API (`/api`), push, vault             |
| `apps/scope` (Scope)                | your phone | The metaclient: fleet view, approvals, push, vault unlock; opens threads in the T3 workspace UI         |

## Releases

Tag `v<upstream>-fleet.<n>` on `main` and push it, or run the **Fleet release** workflow by hand with a version. Linux archives publish the release; the macOS archive attaches itself when its runner finishes. The installer reads releases from this repository (`FLEET_REPO` overrides it).

## The metaserver

Deploy or update it (builds `apps/metaserver` to one file, installs Node, a systemd unit, and Caddy):

```sh
scripts/fleet/deploy-metaserver root@metaserver
```

On a host that still runs the old `fleet-hub` install, the script moves `/var/lib/fleet-hub` to `/var/lib/t3-metaserver` and removes the old unit, wrapper and `/opt/fleet-hub`.

The metaserver listens on port 8780. Caddy serves it at `https://metaserver.example.ts.net` on port 443 with a Let's Encrypt certificate it gets from tailscaled (the script sets `TS_PERMIT_CERT_UID=caddy`), so the tailnet needs HTTPS certificates turned on. Hosts and Scope use the HTTPS address; plain `:8780` still answers on the tailnet. Certificate names appear in public Certificate Transparency logs. Both listen on all interfaces, so the host firewall must admit only SSH and `tailscale0`:

```sh
ufw default deny incoming && ufw allow 22/tcp && ufw allow in on tailscale0 && ufw enable
```

Once SSH over Tailscale works (`ssh root@metaserver.example.ts.net`), close public SSH: `ufw delete allow 22/tcp`.

State lives in `/var/lib/t3-metaserver` (SQLite, the metaserver's SSH key, `apns.json`). `t3-metaserver help` lists the commands.

## Adding a host

```sh
scripts/fleet/install user@host-a --metaserver root@metaserver [--version 0.1.3-fleet.1]
```

The installer:

1. installs the release with the upstream `install.sh` pointed at this repository's releases;
2. runs `t3 service install` (systemd user unit with linger on Linux; a launchd agent on macOS, which needs a logged-in GUI session);
3. installs Claude Code with its native installer;
4. mints two credentials on the host (an MCP-client token and a bearer token without `environment:maintain`), pipes them to `t3-metaserver link`, and issues the host a fleet token;
5. adds the fleet MCP to Claude (`claude mcp add --scope user fleet`) and Codex (`~/.codex/config.toml`), and puts `T3_METASERVER_URL`/`T3_METASERVER_TOKEN` in `~/.t3/service.env` for browser credential fill;
6. prints a one-time browser pairing link and the Settings → Providers URL.

Re-run it with `--version` to update; `t3 update` is disabled. Codex is installed from Settings → Providers (Install, then Continue with ChatGPT). Claude signs in there too (Sign in with Claude: open the link, paste the code into the terminal panel).

## Registry and scans

`node scripts/fleet/import-registry.ts --metaserver root@metaserver [--inventory hosts.ini]` imports your ssh config, Tailscale peers and Ansible INI inventories into the metaserver, once. Data never touches the repository.

Scans are read-only and manual. Authorize the metaserver's key on a host, limited to the tailnet:

```sh
echo "from=\"100.64.0.0/10,fd7a:115c:a1e0::/48\" $(ssh root@metaserver t3-metaserver pubkey)" >> ~/.ssh/authorized_keys
```

then `ssh root@metaserver t3-metaserver scan host-a` (or `--all`). Agents ask with `fleet_service_find`.

## Fleet MCP

Every host's agents get `fleet_servers_list`, `fleet_server_info`, `fleet_service_find`, `fleet_overview`, and the T3 orchestration tools re-exported as `fleet_*` with a `server` argument (`fleet_thread_launch`, `fleet_thread_send`, `fleet_thread_wait`, `fleet_thread_read`, ...). There is no gate: every agent can see and drive every server.

## Phones

Scope enrolls with the metaserver by its Tailscale address. The first phone becomes the owner; later phones wait until an enrolled phone (or `t3-metaserver device approve <id>`) approves them. Revoking a phone deletes its wrapped vault key and rotates the vault key at the next unlock.

Phones reach t3 servers through the metaserver, not over a Tailscale path to each machine. Every linked server gets its own relay port on the metaserver (9001, 9002, ... from `T3_METASERVER_RELAY_PORT_BASE`), and Caddy proxies `https://metaserver.example.ts.net:<port>` to that server's t3 URL. A server keeps its port until it is unlinked, so saved connections stay valid; Scope moves older direct connections onto the relay by itself. The ports must be reachable on the tailnet (`ufw allow in on tailscale0` covers them). The deploy script sets `T3_METASERVER_PUBLIC_HOST` to the metaserver's tailnet name; without it the relay is off and phones connect directly. `serve`, `link`, `unlink` and `server remove` rewrite `/etc/caddy/t3-relays.caddy` and reload Caddy; check it with `cat /etc/caddy/t3-relays.caddy`, `t3-metaserver server list --json` (each server's `relayUrl`) and `journalctl -u t3-metaserver` for sync errors.

Push needs an APNs auth key from the Apple developer account: put the `.p8` on the metaserver and write `/var/lib/t3-metaserver/apns.json`:

```json
{
  "keyPath": "/var/lib/t3-metaserver/AuthKey_XXXX.p8",
  "keyId": "XXXX",
  "teamId": "TEAM",
  "topic": "io.dafacility.fleetscope"
}
```

Build Scope with `DEVELOPMENT_TEAM=<team> BUILD_NUMBER=<n> apps/scope/scripts/build-ios.sh ipa` (or `simulator`).

## Vault and 1Password

The metaserver signs in to 1Password with the `op` CLI only; the desktop app is never installed.

1. Once, on the metaserver: `op account add` (address, email, Secret Key, password, second factor). This registers the metaserver as a device.
2. Each phone registers its vault key from Scope → Vault.
3. On the metaserver: `printf '%s' '<master password>' | t3-metaserver vault setup --account <shorthand>`. It checks the password with `op signin`, stores it encrypted with a new vault key, wraps that key for every phone with a key, and prints a recovery code once. Keep the code in 1Password and offline.
4. Scope → Vault → Unlock with Face ID. The metaserver stays unlocked while that screen is open; closing it, backgrounding the app or a 30 s heartbeat gap runs `op signout` and wipes the key.

The metaserver never runs `op signout --forget`. Recovery after losing every phone: enroll a new phone, register its key, then `t3-metaserver vault recover` with the code on stdin.

Testing without a real account: `scripts/fleet/op-stub.mjs` mimics `op` (set `T3_METASERVER_OP_BIN` and `OP_STUB_HOME`).
