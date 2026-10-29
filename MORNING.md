# Status

The fleet system is paused. Nothing from it is deployed. Decisions are in `TODO.md`; [docs/operations/fleet.md](docs/operations/fleet.md) still describes how to deploy it again.

## What was removed

- **t3 metaserver:** the service, its state, Caddy and the 1Password CLI are gone from the VPS, along with the t3 server and Claude Code that were installed there for it. The VPS keeps its tailnet-only firewall.
- **Fleet t3 servers:** the Linux host runs upstream T3 as a user service again, with its chats kept. The maintainer's Mac runs only the desktop app.
- **Fleet MCP:** removed from Claude and Codex on every host, and the metaserver's and Scope's sessions on the Linux host are revoked.

## What is left

- The code in this fork (`apps/metaserver`, `apps/scope`, `scripts/fleet`) and the `-fleet` releases on GitHub.
- Scope builds on Selfstore; delete the app from the phone.
- The Tailscale tag on the VPS and any policy rules added for it.

## Why it was paused

- The metaserver relays connections instead of aggregating them, so the phone still opens one connection per t3 server.
- Scope is a copy of the mobile app with tabs bolted on, and the bugs came from there.
- Upstream T3 already lets an agent on one host use another environment's MCP endpoint (`/mcp`, OAuth sign-in), which covers agents starting work across hosts without a metaserver.
