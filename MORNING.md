# Morning report

Overnight build of the fleet system in `TODO.md`. Decisions are recorded in `TODO.md` → Decisions; operating instructions are in [docs/operations/fleet.md](docs/operations/fleet.md). Nothing here names a real host: "the VPS" is the hub server, "your Mac" is the machine you ran things from.

## What works, and how to try it

### 1. Fork base and releases

- `main` is upstream **v0.1.3** plus the fork commits. The old `main` is kept locally as `backup/pre-v013-main`.
- **Fleet release** (`.github/workflows/fleet-release.yml`) built and published **`v0.1.3-fleet.1`**: `t3` archives for linux-x64, linux-arm64 and darwin-arm64, plus `SHA256SUMS`, on this repo's GitHub releases.
- Upstream workflows are disabled on the fork, because they need runners and secrets it doesn't have.
- T3 Connect is gone: `infra/relay` is deleted, the server never starts CloudLink or the tunnel, and the web UI hides Connect and Clerk.
- Self-update is gone: no update buttons, `server.updateServer` refuses, and `t3 update` refuses.
- `scripts/fleet/pii-check.sh` runs in the pre-commit hook. It checks for public IPs and emails, plus a private denylist kept outside the repo.

### 2. Installer (tested against the VPS)

```sh
scripts/fleet/install user@host --hub root@<hub tailscale name> [--version 0.1.3-fleet.1]
```

On the VPS (as root) it did the following:

- installed `t3` 0.1.3-fleet.1 and ran it as a systemd user service with linger;
- installed Claude Code;
- linked the host to the hub;
- added the fleet MCP to Claude (`claude mcp list` shows `fleet … ✔ Connected`) and to Codex (`~/.codex/config.toml`);
- wrote `FLEET_HUB_URL` and `FLEET_HUB_TOKEN` to `~/.t3/service.env`;
- printed a pairing link and the Settings → Providers URL.

Re-running it is idempotent and replaces the host's fleet token. `t3 update` on the host refuses.

The macOS path (launchd, logged-in GUI session check) is written but untested, because the VPS was the only host I was allowed to touch.

### 3. Registry and discovery

- The hub has **23 servers**, imported once from your Mac's ssh config and Tailscale peers. No Ansible inventories were found.
- **No real host was scanned.** The scanner was tested on the VPS itself. It found a throwaway compose project there, which I removed afterwards (docker is still installed on the VPS). `fleet_service_find "rustdesk"` returned its SSH target and `docker compose pull && up -d` hint.

### 4. Hub with the fleet MCP (running on the VPS)

- `fleet-hub` runs under systemd on port 8780, behind Caddy at `https://<hub tailscale name>` (a real Let's Encrypt certificate via Tailscale). `ssh root@<VPS> fleet-hub help` lists the commands.
- Agents see the following tools; there is no gate:
  - `fleet_servers_list`, `fleet_server_info`, `fleet_service_find`, `fleet_overview`;
  - T3's thread and project tools as `fleet_*` with a `server` argument.
- **End-to-end test passed** on your Mac, with two throwaway T3 servers and a local hub:
  1. a real Claude agent on server B called `fleet_overview`;
  2. it called `fleet_thread_launch` on server A, then `fleet_thread_wait` and `fleet_thread_read`;
  3. it answered `HOST-A SAID: pong from host-a`.
- Phone API:
  - enrollment: the first phone is owner, later phones wait for approval;
  - device approve and revoke;
  - combined overview;
  - pairing links minted for phones with no `environment:maintain`;
  - APNs sender (tested against a fake APNs server).
- Tests: 16 hub tests and 6 fleet package tests.

### 5. Provider sign-in

- **Claude:** Settings → Providers → **Sign in with Claude** runs `claude auth login` on the host and shows its terminal in the panel. Open the link anywhere, then paste the code into the terminal. Covered by tests with a fake PTY. The real login is yours to do.
- **Codex:** **Install**, then **Continue with ChatGPT**, in the same panel (upstream flow, unchanged). Not tried against a real account.

### 6. Scope (the iPhone app)

- Bundle id `io.dafacility.fleetscope`, with a new icon (`apps/scope/assets/scope/icon.png`, plus the iOS set in `assets/scope/ios/`).
- Three tabs: **Fleet**, **Workspace** (T3's chats) and **Settings**.
  - **Fleet** lists the T3 servers (tap one to pair and open it in Workspace), the phones controlling the fleet (approve or revoke), and the other registry servers (tap to copy their SSH command).
  - **Settings → Fleet** holds **Hub & Push** (push enable and test, disconnect) and **Vault**.
- **Vault** (Settings → Fleet → Vault): register the phone's Secure Enclave key, unlock with Face ID (unlocked only while the screen is open, with a heartbeat), and approve or deny each credential request.
- Built and signed for development, published to Selfstore as **Scope `v1.0.0-b3`** (`/a/scope` on your Selfstore; the link also arrived by Pushover). Skip `v1.0.0-b2`: it crashes on the Fleet screen once data loads. Lint caught an API that Hermes lacks; it is fixed in b3.
- Tested so far:
  - **Launches in the simulator** and shows the setup screen.
  - The flows behind it were **not tapped through**: T3's device tools are disabled in this environment, so the simulator couldn't be driven.
  - The hub side of every flow was tested with scripted clients.
  - CryptoKit ↔ hub HPKE interop was checked on your Mac.
  - The Secure Enclave path compiles but needs your phone.

### 7. Vault and 1Password (tested on the VPS with a stub `op`)

- Tested on the VPS with a stub `op` and a simulated phone (software key):
  - `fleet-hub vault setup`, then an unlock from the simulated phone;
  - `op signin --raw` with the password on stdin;
  - a credential request approved on the "phone" returned the login;
  - after 30 s without a heartbeat it locked and ran `op signout`; the account stayed added, with no `--forget`.
- Unit-tested: revoking a phone rotates the vault key at the next unlock, and the recovery code survives rotation.
- All test state was removed from the VPS afterwards.
- The real 1Password CLI (2.41) is installed on the VPS. It is not signed in.

### 8. Browser credentials and passkeys

- **Login fill:** in every frame, an isolated-world script notices login forms; the server asks the hub, which asks the phone, then fills and submits. Verified in headless Chromium: it asked once, filled both fields, submitted, and stayed invisible to the page.
- **Passkeys:**
  - A main-world `navigator.credentials` override bridges to the hub's software authenticator: ES256, BE/BS flags, stored encrypted with the vault key.
  - Verified in headless Chromium: a page registered a passkey and then signed in with it.
  - `@simplewebauthn/server` accepts the registration, and the assertion signature verifies.
  - The origin comes from CDP, not the page.

## Checks

`vp run check:changed v0.1.3` passes over the whole fork diff: format, lint, typecheck (38 packages), knip, unused patches, and the 245 test files beside the changes. The browser tests needed Playwright's Chrome Headless Shell 1223, which I downloaded into `~/Library/Caches/ms-playwright`; the repo is unchanged.

The fork's CI workflow is disabled along with the other upstream workflows (they need runners the fork doesn't have), so nothing runs on push except **Fleet release** on tags.

## Stubbed or unfinished

- **Push:** the APNs `.p8` key isn't on the hub yet, so `/api/push/test` answers "not configured" until you add it.
- **Remote browser view:** Scope keeps T3's direct preview stream. The **hub relay option is not built**.
- **TOTP fallback** for 1Password (only needed if `op` asks for 2FA on every sign-in) is not built. Run the test below first.
- **Scope on Android** is not built.
- **Interactive simulator testing of Scope** was not possible (see 6).
- **The VPS's own T3 server** is linked to the hub under the VPS's hostname, over its tailnet URL. It started as a test install; remove it with `t3 service uninstall` if the hub should only be a hub.
- **Old credentials accumulate:** re-linking a host leaves its previous hub sessions valid on that host. List and revoke them with `t3 auth session list` / `t3 auth session revoke` if you care.
- **Throwaway servers on your Mac:** two T3 servers and a local hub ran under `/tmp/fleet-test` during testing. I stopped them by PID. Nothing touched `~/.t3`.

## Your checklist, in order

1. ~~**Tailscale on the VPS.**~~ Done after you approved the node. Tailscale SSH is off (your call); plain `sshd` answers over the tailnet with the existing key. Public SSH is closed: ufw now admits only `tailscale0`. The VPS's test T3 server and the hub are re-linked with their tailnet addresses, and agents there reach the fleet MCP over the tailnet. To reach the VPS from now on, use `ssh root@<hub tailscale name>`.
2. **Point hosts at the hub's tailnet name.** For each host, `scripts/fleet/install user@host --hub root@<hub tailscale name>`. The default hub URL is `https://<hub tailscale name>`. On macOS hosts, be logged in to the desktop first.
3. **Provider sign-ins** on each host, using the link the installer prints (it pairs your browser):
   - Settings → Providers → Sign in with Claude: paste the code into the terminal.
   - Codex: Install, then Continue with ChatGPT.
4. **Install Scope `v1.0.0-b5`** (or the newest) from Selfstore in Safari, with Tailscale connected. In the Tailscale iOS app, turn on VPN On Demand.
5. **Enroll** in Scope. From b5 the HTTPS hub address is prefilled; otherwise type `<hub tailscale name>` and Scope uses HTTPS. (b4 prefills the old `http://…:8780` address, which still works.) This first phone becomes the owner. Tap **Enable push**.
6. **APNs:**
   1. Create an APNs auth key (`.p8`) in the Apple developer account.
   2. Copy it to `/var/lib/fleet-hub/` on the hub and write `/var/lib/fleet-hub/apns.json` (format in docs/operations/fleet.md; topic `io.dafacility.fleetscope`).
   3. Run `systemctl restart fleet-hub`, then **Test push** in Scope.
7. **1Password test (phase 7).** Do this before step 8. On the hub:
   ```sh
   op account add --address <you>.1password.com --email <you> --shorthand my   # Secret Key, password, 2FA
   read -rs PW; printf '%s\n' "$PW" | op signin --account my --raw >/dev/null && echo "piped password works"
   op signout --account my            # plain signout, NEVER --forget
   printf '%s\n' "$PW" | op signin --account my --raw >/dev/null && echo "no 2FA needed after signout"; unset PW
   ```
   - Does `op account add` register the device with one 2FA prompt?
   - Does the second sign-in ask only for the password? If it asks for 2FA again, tell me: the TOTP fallback in TODO.md is then needed.
8. **Vault setup.**
   1. In Scope → Vault: **Register this phone's key**.
   2. On the hub: `read -rs PW; printf '%s' "$PW" | fleet-hub vault setup --account my; unset PW`.
   3. Save the printed **recovery code** in 1Password and offline.
   4. In Scope → Vault: **Unlock with Face ID**. The hub uses the account named at setup.
9. **Scans.** On each host you want scanned, authorize the hub's key, limited to the tailnet:
   - `echo "from=\"100.64.0.0/10,fd7a:115c:a1e0::/48\" $(ssh root@<hub> fleet-hub pubkey)" >> ~/.ssh/authorized_keys`
   - Then run `ssh root@<hub> fleet-hub scan --all`.
10. Optional: remove docker from the VPS (`apt purge docker.io docker-compose-v2`). It was only needed for the scanner test.
