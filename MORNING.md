# Status

Where the fleet system stands. Decisions are in `TODO.md`; operating instructions are in [docs/operations/fleet.md](docs/operations/fleet.md). Terms follow AGENTS.md: the **t3 metaserver** runs on the VPS, **t3 servers** run on hosts, and **Scope** is the metaclient. Nothing here names a real host.

## Running now

- **t3 metaserver** on the VPS (`t3-metaserver`, systemd), behind Caddy at `https://<metaserver tailnet name>` with a Let's Encrypt certificate from Tailscale. The firewall admits only `tailscale0`; public SSH is closed.
- **Three t3 servers** on `0.1.3-fleet.2`, all linked: the VPS's own test server, a Linux host (its old upstream install was archived to `~/Downloads` on that host, then upgraded in place with its chats intact), and the maintainer's Mac (a separate install under `~/.t3-fleet` on port 3774, served by `tailscale serve` on 443, leaving the desktop app's `~/.t3` alone).
- **Relay:** each t3 server has its own HTTPS port on the metaserver (9001, 9002, …), generated into `/etc/caddy/t3-relays.caddy`. Scope pairs through it, so the phone opens one Tailscale path instead of one per host. Tested end to end: pairing, token, WebSocket ticket and live socket through every relay port, and in Scope on the simulator.
- **Agents across hosts:** every t3 server's Claude and Codex, and Claude and Codex on the Mac, have the fleet MCP (`fleet_*` tools) at the metaserver. A Codex run on the Linux host and a Claude run on the Mac were started and answered through it.

## Scope

- **v1.0.0-b9** on Selfstore. Tabs: **Fleet** (t3 servers, controllers, other registry hosts), **Workspace** (T3 chats), **Settings** (Fleet section: Metaserver & Push, Vault).
- b9 moves an enrolled phone from the old metaserver address to the one it was built with, keeping its device token, so the rename needs no re-enroll.
- Fixed and checked in the simulator:
  - the new-chat button sat in the tab bar's corner after opening Workspace from Fleet;
  - the composer shown when an environment has no model hid behind the keyboard.
- Known and cosmetic: the first time Workspace opens from Fleet, the chat list can start scrolled under the header while chats load above it. One scroll fixes it.
- Older finished chats sit in the collapsed **Settled** section at the bottom of the list; that is T3's normal behaviour.

## Needs you

1. **Install Scope b9** and open it. It should reconnect by itself; the Fleet tab lists the three servers. If it shows the setup screen instead, enroll at the prefilled address and say so; the old enrollment is the owner and can approve the new one.
2. **Tailscale policy:** the metaserver is now tagged like the Linux host, so it can no longer reach the Mac's t3 server (it shows `fetch failed` in Fleet). Allow `tag:server` → the Mac's tailnet IP on port 443.
3. **Provider sign-in on the VPS's t3 server:** it has no signed-in agent, so a new chat there shows "No model is available". Sign in with Claude under Settings → Providers on that server, or remove that server if the VPS should only run the metaserver.
4. **Test chats** created while testing (relay and smoke tests) can be archived from the chat list.
5. Still open from before: the APNs key for push, the 1Password `op signin` test and vault setup (see `docs/operations/fleet.md`).

## Housekeeping notes

- Re-linking a host leaves its previous metaserver sessions valid on that host (labels `fleet-hub` / `t3-metaserver`). List them with `t3 auth session list`; only the newest per host is in use.
- The fork release workflow's macOS job keeps getting cancelled waiting for a GitHub runner. The macOS archive for `0.1.3-fleet.2` was built locally from the tag and attached with its checksum.
- The fleet build still sends upstream's anonymous analytics; turning that off is not done yet.
