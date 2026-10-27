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
- **Out of scope:**
  - Windows.
  - The desktop client.
  - SSH certificates or an approving SSH agent.
  - Restricting the agents' shared SSH key to the tailnet. A side task, which can be done any time with `from="100.64.0.0/10,fd7a:115c:a1e0::/48"` in each server's authorized_keys.

## 0. Fork and release pipeline
- [x] Fork to `da-facility/t3-code`.
- [ ] Base the working branch on upstream v0.1.3; the fork's `main` currently matches upstream `main`. New work goes in new directories (`apps/hub`, new mobile app, new packages) to keep rebases small.
- [ ] CI publishes the fork's `t3` release archives to its GitHub releases. The installer sets `T3CODE_RELEASE_BASE_URL` to point at them.
- [ ] Add a no-PII rule to AGENTS.md. Also note there that this TODO.md is intentional: upstream's AGENTS.md says not to commit plans.
- [ ] Remove updates:
  - `server.updateServer` RPC (`apps/server/src/cloud/selfUpdate.ts`, `ws.ts`).
  - Desktop "update everything" and electron-updater.
  - Disable `t3 update`.
- [ ] Remove T3 Connect:
  - Delete `infra/relay` (about 27k lines).
  - Stop CloudLink and the managed tunnel from starting (`apps/server/src/cloud/`).
  - Hide the Connect and Clerk UI. Clerk appears in about 58 files across web, mobile and desktop; disable at the entry points rather than deleting.
  - **Keep** `bootService`, `serviceLauncherClient` and `servicePreflight`: they live in `cloud/` but the background service needs them.

## 1. Service installer (macOS + Linux)
- [ ] `install <ssh-target> [--version v]` script run from your machine. Re-running it with a new version is the update path.
- [ ] Install the fork's `t3`, then `t3 service install`. Linux: linger. macOS: needs a logged-in session.
- [ ] Providers:
  - Claude: native installer (`~/.local/bin/claude`); T3 then updates it with `claude update`.
  - Codex: T3's managed install (`~/.t3/tools/codex`); T3 updates it.
- [ ] Prints the link to Settings → Providers on the new host for sign-in.

## 2. Provider sign-in in Settings → Providers
- [ ] Codex: already exists as "Connect with ChatGPT", including remote hosts. If the redirect can't come back, you paste the final URL into the panel (`CodexChatGptAuth.ts`, `CodexChatGptHandoff.ts`). Check that it works through the fork as-is.
- [ ] Claude: new. Run `claude auth login` on the host, show its URL in the panel, and take the code you paste back. The pattern to follow is in `ProviderAuthService.ts`.

## 3. Server registry (all SSH-able machines, not only T3)
- [ ] Schema in the repo; **data only on the hub** (host, address, user, port, key name, tags).
- [ ] One-off import from `~/.ssh/config`, `tailscale status --json` and the existing Ansible inventories onto the hub. Nothing is committed.
- [ ] The hub's own SSH key (new, restricted to the tailnet with `from=`) scans every host:
  - `docker ps -a` and `docker inspect`: compose working dir, config files, image tag.
  - systemd, brew and launchd services.
  - Results go into the services table.
- [ ] Agent lookup tool, e.g. "where is RustDesk and how do I update it". Agents then connect with their own host's key.

## 4. Hub (`apps/hub`, reusing `contracts` and `client-runtime`)
- [ ] Pairs with each T3 server listed in the registry. Tokens have no `environment:maintain`.
- [ ] One combined view of projects, threads and pending requests.
- [ ] Fleet MCP: list servers, read threads, launch threads and send prompts anywhere.
- [ ] Phone enrollment: the first device becomes owner; extra devices are approved by an enrolled one.

## 5. Hook them up
- [ ] The installer pairs a new server with the hub and gives its agents the fleet MCP.
- [ ] End-to-end: an agent on one server prompts another and gets the result.

## 6a. Mobile, part 1
- [ ] New app copied from `apps/mobile`, with a new UI (native Liquid Glass via `@expo/ui` / `expo-glass-effect`) and a new bundle id.
- [ ] Connects to the hub for threads, approvals and the fleet.
- [ ] Remote browser view and control: direct stream by default, hub relay as an option.
- [ ] APNs push from the hub (time-sensitive).
- [ ] Phone runs Tailscale (VPN on demand) so it can reach the hub.

## 6b. Mobile, part 2: keys
- [ ] Secure Enclave P-256 key with Face ID; HPKE (CryptoKit ↔ `@hpke/core`). Needs a small native module.
- [ ] Enrollment, revocation (rotates the vault key), recovery code shown at setup.
- [ ] Approval screen: open = unlocked, with a heartbeat to the hub. Each credential request is a confirmation modal.

## 7. Vault and 1Password (on the hub)
2FA: 1Password asks for the second factor when a **new device** signs in, not when an already signed-in device unlocks. So the hub must stay a known device:
- [ ] Setup, once: install the `op` CLI (no desktop app) and run `op account add` (address, email, Secret Key, password, 2FA code). This registers the hub as a device.
- [ ] **Verify first, before building anything else in this phase:** after a plain `op signout`, does `op signin` ask only for the password? One community report says `op` asked for a 2FA code on every sign-in.
  - Also check that the password can be piped on stdin to `op signin --raw`.
- [ ] Never run `op signout --forget`. It removes the account from the device, so the next sign-in counts as a new device and asks for 2FA again.
- [ ] Fallback if `op` does ask for 2FA on every sign-in: store the 1Password TOTP secret in the vault too, and the hub generates the code after phone approval. This only works if 1Password's second factor is TOTP, not a security key.
- [ ] Unlock:
  1. The hub sends a fresh ephemeral key.
  2. The phone runs Face ID, unwraps the vault key and seals it to that ephemeral key.
  3. The hub decrypts the master password and runs `op signin --raw`.
  4. The session token is held in memory only. It lasts up to 30 minutes (`op`'s idle limit).
- [ ] Lock early when needed with `op signout` (the account stays added) and wipe the vault key and token. The vault key is also wiped when the phone's approval screen closes or its heartbeat stops (30 s).

## 8. Browser credential scripts (fork's server browser)
- [ ] Login-form detection and fill, per frame. Asks the hub, which asks the phone (confirmation modal), then fills and submits.
- [ ] Passkeys: a main-world override of `navigator.credentials.create/get`, bridged with `Runtime.addBinding`. The hub signs; BE/BS flags set. New registrations are saved to the vault.

## 9. Bugfix, hardening
- [ ] Recovery drill (lose the phone), vault key rotation drill.

## 10. Profit
