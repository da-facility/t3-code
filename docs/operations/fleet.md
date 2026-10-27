# Fleet: hub, installer, Scope and vault

This fork runs T3 servers on many hosts, coordinated by a hub on a small cloud server that is reachable only over Tailscale. `TODO.md` holds the decisions; this page is how to operate it. Use placeholders like `host-a` and `hub.example.ts.net` when you write about it here.

## Pieces

| Piece                    | Where      | What it does                                                                                     |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| `t3` (fork build)        | every host | The T3 server, built by `.github/workflows/fleet-release.yml` as `<upstream>-fleet.<n>`          |
| `scripts/fleet/install`  | your Mac   | Installs or updates `t3` on a host over SSH, links it to the hub, gives its agents the fleet MCP |
| `apps/hub` (`fleet-hub`) | the hub    | Registry, fleet MCP (`/mcp`), phone API (`/api`), push, vault                                    |
| `apps/scope` (Scope)     | your phone | Fleet view, approvals, push, vault unlock; opens threads in the T3 workspace UI                  |

## Releases

Tag `v<upstream>-fleet.<n>` on `main` and push it, or run the **Fleet release** workflow by hand with a version. Linux archives publish the release; the macOS archive attaches itself when its runner finishes. The installer reads releases from this repository (`FLEET_REPO` overrides it).

## The hub

Deploy or update it (builds `apps/hub` to one file, installs Node and a systemd unit):

```sh
scripts/fleet/deploy-hub root@hub
```

It listens on port 8780 on all interfaces, so the host firewall must admit only SSH and `tailscale0`:

```sh
ufw default deny incoming && ufw allow 22/tcp && ufw allow in on tailscale0 && ufw enable
```

Once SSH over Tailscale works (`ssh root@hub.example.ts.net`), close public SSH: `ufw delete allow 22/tcp`.

State lives in `/var/lib/fleet-hub` (SQLite, the hub's SSH key, `apns.json`). `fleet-hub help` lists the commands.

## Adding a host

```sh
scripts/fleet/install user@host-a --hub root@hub [--version 0.1.3-fleet.1]
```

The installer:

1. installs the release with the upstream `install.sh` pointed at this repository's releases;
2. runs `t3 service install` (systemd user unit with linger on Linux; a launchd agent on macOS, which needs a logged-in GUI session);
3. installs Claude Code with its native installer;
4. mints two credentials on the host (an MCP-client token and a bearer token without `environment:maintain`), pipes them to `fleet-hub link`, and issues the host a fleet token;
5. adds the fleet MCP to Claude (`claude mcp add --scope user fleet`) and Codex (`~/.codex/config.toml`), and puts `FLEET_HUB_URL`/`FLEET_HUB_TOKEN` in `~/.t3/service.env` for browser credential fill;
6. prints a one-time browser pairing link and the Settings → Providers URL.

Re-run it with `--version` to update; `t3 update` is disabled. Codex is installed from Settings → Providers (Install, then Continue with ChatGPT). Claude signs in there too (Sign in with Claude: open the link, paste the code into the terminal panel).

## Registry and scans

`node scripts/fleet/import-registry.ts --hub root@hub [--inventory hosts.ini]` imports your ssh config, Tailscale peers and Ansible INI inventories into the hub, once. Data never touches the repository.

Scans are read-only and manual. Authorize the hub's key on a host, limited to the tailnet:

```sh
echo "from=\"100.64.0.0/10,fd7a:115c:a1e0::/48\" $(ssh root@hub fleet-hub pubkey)" >> ~/.ssh/authorized_keys
```

then `ssh root@hub fleet-hub scan host-a` (or `--all`). Agents ask with `fleet_service_find`.

## Fleet MCP

Every host's agents get `fleet_servers_list`, `fleet_server_info`, `fleet_service_find`, `fleet_overview`, and the T3 orchestration tools re-exported as `fleet_*` with a `server` argument (`fleet_thread_launch`, `fleet_thread_send`, `fleet_thread_wait`, `fleet_thread_read`, ...). There is no gate: every agent can see and drive every server.

## Phones

Scope enrolls with the hub by its Tailscale address. The first phone becomes the owner; later phones wait until an enrolled phone (or `fleet-hub device approve <id>`) approves them. Revoking a phone deletes its wrapped vault key and rotates the vault key at the next unlock.

Push needs an APNs auth key from the Apple developer account: put the `.p8` on the hub and write `/var/lib/fleet-hub/apns.json`:

```json
{
  "keyPath": "/var/lib/fleet-hub/AuthKey_XXXX.p8",
  "keyId": "XXXX",
  "teamId": "TEAM",
  "topic": "io.dafacility.fleetscope"
}
```

Build Scope with `DEVELOPMENT_TEAM=<team> BUILD_NUMBER=<n> apps/scope/scripts/build-ios.sh ipa` (or `simulator`).

## Vault and 1Password

The hub signs in to 1Password with the `op` CLI only; the desktop app is never installed.

1. Once, on the hub: `op account add` (address, email, Secret Key, password, second factor). This registers the hub as a device.
2. Each phone registers its vault key from Scope → Vault.
3. On the hub: `printf '%s' '<master password>' | fleet-hub vault setup --account <shorthand>`. It checks the password with `op signin`, stores it encrypted with a new vault key, wraps that key for every phone with a key, and prints a recovery code once. Keep the code in 1Password and offline.
4. Scope → Vault → Unlock with Face ID. The hub stays unlocked while that screen is open; closing it, backgrounding the app or a 30 s heartbeat gap runs `op signout` and wipes the key.

The hub never runs `op signout --forget`. Recovery after losing every phone: enroll a new phone, register its key, then `fleet-hub vault recover` with the code on stdin.

Testing without a real account: `scripts/fleet/op-stub.mjs` mimics `op` (set `FLEET_HUB_OP_BIN` and `OP_STUB_HOME`).
