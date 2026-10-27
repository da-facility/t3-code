# TODO

Repo: `da-facility/t3-code`, a public fork of pingdotgg/t3code. **No PII in the repo:** no hostnames, IPs, usernames or key names. Fleet data lives on the hub.

## Decisions

- **Browser:** keep chrome-headless-shell. Inject the credential scripts per frame, the same way T3 injects its clipboard script (`apps/server/src/preview/ServerBrowser.ts:1114`). Bitwarden's autofill code may be used as inspiration; whatever works with the least iteration.
- **Agents reading credentials:** not a priority. The fill submits, or you do, before control goes back to the agent.
- **Updates:**
  - No self-update or client-triggered updates. Remove `server.updateServer` and the update buttons, and disable `t3 update`.
  - Updating means re-running the installer with a new version.
  - Rebase onto upstream only when you pick a new version.
- **T3 Connect:** removed, or at least never invoked. The hub over Tailscale replaces it; push notifications come from the hub.
- **Hub:** cloud Ubuntu server, reachable only over Tailscale. It holds its own SSH key to scan every host; each T3 host keeps its own key and connects directly.
- **Fleet tool:** every agent can see and invoke every server. No gate, no hop limit.
- **Browser stream:** the phone streams directly from the server over Tailscale by default, with an option to relay through the hub.
- **1Password:**
  - `op` uses manual sign-in on the hub. The desktop app is never installed, so there is no fingerprint prompt.
  - The master password is stored encrypted on the hub; each phone holds its own wrapped vault key.
  - An `op` session lasts up to 30 minutes, `op`'s own idle limit, and is ended early with `op signout` when needed.
- **Unlock window:**
  - Lasts while the phone's approval screen is open. Closing or backgrounding it locks the hub; a missed heartbeat also locks it.
  - Every credential use, including the first after Face ID, is a confirmation modal on the phone.
- **Passkeys:** stored on the hub, encrypted with the same vault key, with per-phone keys that can be revoked.
- **Recovery code:** generated at setup and shown once. Save it in 1Password, which stays reachable from your other devices if the phone is lost, plus an offline copy.
- **Provider sign-in:** done from the web UI under Settings → Providers: get a link or code, finish in any browser, paste the code back.
- **Mobile:** React Native app copied from `apps/mobile` with a new UI. The earlier native Swift prototype is retired.
- **Commits:** this machine has no commit-signing setup, so fork commits are unsigned and authored with the GitHub noreply address.
- **Fork versions:** `<upstream version>-fleet.<n>` (first: `0.1.3-fleet.1`), built by `.github/workflows/fleet-release.yml` on a `v*-fleet.*` tag or by hand. Linux archives publish the release; the macOS archive attaches itself when its runner finishes. The upstream workflows are disabled on the fork (they need runners and secrets the fork does not have).
- **Connect off:** the server skips the CloudLink/tunnel reconcile at startup and the web UI's `hasCloudPublicConfig()` is always false. `T3CODE_FLEET_ENABLE_CONNECT=1` (server) and `VITE_T3CODE_FLEET_ENABLE_CONNECT=1` (web) bring it back for debugging only. Scope ships with no relay or Clerk config. The desktop app is untouched (out of scope).
- **No self-update:** the server never advertises `serverSelfUpdate`, `server.updateServer` fails with "re-run the installer", the web update button is hidden, and `t3 update` refuses unless `T3CODE_FLEET_ENABLE_UPDATE=1`.
- **Hub runtime:** plain TypeScript on Node 26 with `node:sqlite` and no runtime dependencies, bundled to one file and run by systemd as `fleet-hub` on port 8780. It listens on all interfaces; the firewall only admits SSH and `tailscale0`. State lives in `/var/lib/fleet-hub` (mode 700).
- **Hub to T3:** the installer mints two credentials on each host and pipes them through the installing machine's memory to the hub: an MCP-client token (`t3 auth mcp-client issue --access full-access`, 10-year TTL) for T3's own `/mcp`, and a bearer token with every standard scope except `environment:maintain` and the relay scopes, used only to mint phone pairing links. The hub stores both in SQLite (root, 0600) because it must present them.
- **Fleet MCP:** the hub re-exports an allowlist of T3's orchestration tools as `fleet_*` with a `server` argument (schemas come live from the linked servers), plus `fleet_servers_list`, `fleet_server_info`, `fleet_service_find` and `fleet_overview`. Each host gets its own fleet token (stored hashed). Agents get it through user-level config T3 already honours: `claude mcp add --scope user` and `[mcp_servers.fleet]` in `~/.codex/config.toml`.
- **Codex install:** T3's managed Codex install is only reachable through the web UI's RPC, so the installer leaves it as one click (Install, then Continue with ChatGPT) next to Claude's sign-in in Settings → Providers.
- **Claude sign-in:** Settings → Providers runs `claude auth login` in a PTY and shows it in the panel's terminal; paste the code back there.
- **Scope and threads:** Scope talks to the hub for the fleet view, enrollment and push, and pairs directly with each T3 server (the hub mints the pairing link) to reuse T3's thread, composer and approval UI. T3's MCP cannot list or answer permission approvals, so the hub alerts on a thread entering `waiting` and the approval itself happens over the direct connection.
- **Push:** the hub sends APNs itself with a `.p8` key you provide (`/var/lib/fleet-hub/apns.json`); development-signed builds use the APNs sandbox.
- **Scope identity:** bundle id `io.dafacility.fleetscope`; the Apple team id is passed at build time (`DEVELOPMENT_TEAM`) and never committed.
- **Scanning:** manual (`fleet-hub scan <id>|--all`) with the hub's own key, which each host must authorize with `from=` limited to the tailnet. No real host was scanned during setup.
- **Registry import:** ran once from the installing Mac (`scripts/fleet/import-registry.ts`): ssh config and Tailscale peers. No Ansible inventories were found; the importer takes INI inventories with `--inventory`.
- **Vault crypto:** HPKE base mode with DHKEM(P-256), HKDF-SHA256 and AES-256-GCM (CryptoKit's `P256_SHA256_AES_GCM_256`, `@hpke/core` on the hub; interop checked). The master password and passkey private keys are AES-256-GCM under the vault key K. The recovery code is 32 random bytes that derive an HPKE key pair (RFC 9180 DeriveKeyPair); the hub keeps only its public half and K sealed to it, so a rotated K is re-sealed without the code. Credential requests wait two minutes for the phone.
- **Vault setup happens on the hub:** `fleet-hub vault setup` reads the master password on stdin, checks it with `op signin`, then signs out. Phones register their public key first; a phone enrolled later gets K wrapped at the next unlock from an existing phone.
- **Browser fill:** a login form in any frame prompts the phone at most once per site every two minutes; the approved login is filled and submitted from an isolated world. Passkeys use a main-world `navigator.credentials` override; the server takes the origin from the CDP execution context, never from the page, and the hub checks the rpId against it. Conditional (autofill) passkey requests are not answered.
- **Simulator testing:** T3's device tools are turned off in this environment, so Scope was only launched in the simulator (setup screen renders); interactive flows were tested against the hub with scripted clients instead.
- **VPS firewall:** ufw denies all incoming traffic except 22/tcp and anything on `tailscale0`. Public SSH stays open until Tailscale SSH is confirmed.
- **Out of scope:**
  - Windows.
  - The desktop client.
  - SSH certificates or an approving SSH agent.
  - Restricting the agents' shared SSH key to the tailnet. A side task, which can be done any time with `from="100.64.0.0/10,fd7a:115c:a1e0::/48"` in each server's authorized_keys.

## 0. Fork and release pipeline

- [x] Fork to `da-facility/t3-code`.
- [x] Base the working branch on upstream v0.1.3; the fork's `main` currently matches upstream `main`. New work goes in new directories (`apps/hub`, new mobile app, new packages) to keep rebases small.
- [x] CI publishes the fork's `t3` release archives to its GitHub releases. The installer sets `T3CODE_RELEASE_BASE_URL` to point at them.
- [x] Add a no-PII rule to AGENTS.md. Also note there that this TODO.md is intentional: upstream's AGENTS.md says not to commit plans.
- [x] Remove updates:
  - `server.updateServer` RPC (`apps/server/src/cloud/selfUpdate.ts`, `ws.ts`).
  - Desktop "update everything" and electron-updater.
  - Disable `t3 update`.
- [x] Remove T3 Connect:
  - Delete `infra/relay` (about 27k lines).
  - Stop CloudLink and the managed tunnel from starting (`apps/server/src/cloud/`).
  - Hide the Connect and Clerk UI. Clerk appears in about 58 files across web, mobile and desktop; disable at the entry points rather than deleting.
  - **Keep** `bootService`, `serviceLauncherClient` and `servicePreflight`: they live in `cloud/` but the background service needs them.

## 1. Service installer (macOS + Linux)

- [x] `install <ssh-target> [--version v]` script run from your machine. Re-running it with a new version is the update path.
- [x] Install the fork's `t3`, then `t3 service install`. Linux: linger. macOS: needs a logged-in session.
- [x] Providers (Codex is one click in the UI, see Decisions):
  - Claude: native installer (`~/.local/bin/claude`); T3 then updates it with `claude update`.
  - Codex: T3's managed install (`~/.t3/tools/codex`); T3 updates it.
- [x] Prints the link to Settings → Providers on the new host for sign-in.

## 2. Provider sign-in in Settings → Providers

- [ ] Codex: already exists as "Connect with ChatGPT", including remote hosts. If the redirect can't come back, you paste the final URL into the panel (`CodexChatGptAuth.ts`, `CodexChatGptHandoff.ts`). Check that it works through the fork as-is.
- [x] Claude: new. Run `claude auth login` on the host, show its URL in the panel, and take the code you paste back. The pattern to follow is in `ProviderAuthService.ts`.

## 3. Server registry (all SSH-able machines, not only T3)

- [x] Schema in the repo; **data only on the hub** (host, address, user, port, key name, tags).
- [x] One-off import from `~/.ssh/config`, `tailscale status --json` and the existing Ansible inventories onto the hub. Nothing is committed.
- [x] The hub's own SSH key (new, restricted to the tailnet with `from=`) scans every host:
  - `docker ps -a` and `docker inspect`: compose working dir, config files, image tag.
  - systemd, brew and launchd services.
  - Results go into the services table.
- [x] Agent lookup tool, e.g. "where is RustDesk and how do I update it". Agents then connect with their own host's key.

## 4. Hub (`apps/hub`, reusing `contracts` and `client-runtime`)

- [x] Pairs with each T3 server listed in the registry. Tokens have no `environment:maintain`.
- [x] One combined view of projects, threads and pending requests.
- [x] Fleet MCP: list servers, read threads, launch threads and send prompts anywhere.
- [x] Phone enrollment: the first device becomes owner; extra devices are approved by an enrolled one.

## 5. Hook them up

- [x] The installer pairs a new server with the hub and gives its agents the fleet MCP.
- [x] End-to-end: an agent on one server prompts another and gets the result.

## 6a. Mobile, part 1

- [x] New app copied from `apps/mobile`, with a new UI (native Liquid Glass via `@expo/ui` / `expo-glass-effect`) and a new bundle id.
- [x] Connects to the hub for threads, approvals and the fleet.
- [ ] Remote browser view and control: direct stream by default, hub relay as an option.
- [x] APNs push from the hub (time-sensitive). Needs your APNs key (see MORNING.md).
- [ ] Phone runs Tailscale (VPN on demand) so it can reach the hub.

## 6b. Mobile, part 2: keys

- [x] Secure Enclave P-256 key with Face ID; HPKE (CryptoKit ↔ `@hpke/core`). Needs a small native module.
- [x] Enrollment, revocation (rotates the vault key), recovery code shown at setup.
- [x] Approval screen: open = unlocked, with a heartbeat to the hub. Each credential request is a confirmation modal.

## 7. Vault and 1Password (on the hub)

2FA: 1Password asks for the second factor when a **new device** signs in, not when an already signed-in device unlocks. So the hub must stay a known device:

- [ ] Setup, once: install the `op` CLI (no desktop app) and run `op account add` (address, email, Secret Key, password, 2FA code). This registers the hub as a device.
- [ ] **Verify first, before building anything else in this phase:** after a plain `op signout`, does `op signin` ask only for the password? One community report says `op` asked for a 2FA code on every sign-in.
  - Also check that the password can be piped on stdin to `op signin --raw`.
- [ ] Never run `op signout --forget`. It removes the account from the device, so the next sign-in counts as a new device and asks for 2FA again.
- [ ] Fallback if `op` does ask for 2FA on every sign-in: store the 1Password TOTP secret in the vault too, and the hub generates the code after phone approval. This only works if 1Password's second factor is TOTP, not a security key.
- [x] Unlock:
  1. The hub sends a fresh ephemeral key.
  2. The phone runs Face ID, unwraps the vault key and seals it to that ephemeral key.
  3. The hub decrypts the master password and runs `op signin --raw`.
  4. The session token is held in memory only. It lasts up to 30 minutes (`op`'s idle limit).
- [x] Lock early when needed with `op signout` (the account stays added) and wipe the vault key and token. The vault key is also wiped when the phone's approval screen closes or its heartbeat stops (30 s).

## 8. Browser credential scripts (fork's server browser)

- [x] Login-form detection and fill, per frame. Asks the hub, which asks the phone (confirmation modal), then fills and submits.
- [x] Passkeys: a main-world override of `navigator.credentials.create/get`, bridged with `Runtime.addBinding`. The hub signs; BE/BS flags set. New registrations are saved to the vault.

## 9. Bugfix, hardening

- [ ] Recovery drill (lose the phone), vault key rotation drill.

## 10. Profit
