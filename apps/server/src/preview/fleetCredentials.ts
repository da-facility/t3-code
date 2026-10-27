// @effect-diagnostics globalFetch:off globalDate:off - Runs inside Playwright's promise-based CDP callbacks.
import type { CDPSession } from "playwright-core";

/**
 * Fork: an isolated-world script spots a login form per frame and calls a CDP binding; the hub
 * asks the phone and an approved login is filled and submitted. Off unless the installer set
 * FLEET_HUB_URL and FLEET_HUB_TOKEN in the service environment.
 */

const WORLD = "t3-fleet-credentials";
const BINDING = "__t3FleetCredentials";
/** One phone prompt per site per window, however often the page re-renders its form. */
const ASK_INTERVAL_MS = 2 * 60_000;
/** The hub waits up to two minutes for the phone. */
const HUB_TIMEOUT_MS = 150_000;

export const FLEET_CREDENTIAL_SCRIPT = `(() => {
  if (globalThis.__t3FleetFill) return;
  const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";
  const findLogin = () => {
    const password = [...document.querySelectorAll('input[type="password"]')].find(visible);
    if (!password) return null;
    const scope = password.form ?? document;
    const fields = [...scope.querySelectorAll('input:not([type]), input[type="text"], input[type="email"], input[type="tel"]')]
      .filter(visible);
    const named = fields.find((field) => /username|email/i.test(field.autocomplete || field.name || field.id || ""));
    const before = fields.filter((field) => field.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { password, username: named ?? before.at(-1) ?? null };
  };
  // The prototype setter from this world bypasses value trackers that frameworks
  // install on the element in the page's world, so their input handlers see a change.
  const setValue = (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  globalThis.__t3FleetFill = (username, password) => {
    const login = findLogin();
    if (!login) return false;
    if (login.username && username) setValue(login.username, username);
    if (password) setValue(login.password, password);
    const form = login.password.form;
    const submit = form?.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
    if (submit) submit.click();
    else form?.requestSubmit?.();
    return true;
  };
  let asked = false;
  const check = () => {
    if (asked || typeof globalThis.${BINDING} !== "function" || !findLogin()) return;
    asked = true;
    globalThis.${BINDING}(JSON.stringify({ url: location.href }));
  };
  const start = () => {
    check();
    new MutationObserver(check).observe(document.documentElement, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["type", "style", "class", "hidden"],
    });
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})()`;

export interface FleetHubConfig {
  readonly url: string;
  readonly token: string;
}

export function fleetHubConfig(env: NodeJS.ProcessEnv = process.env): FleetHubConfig | null {
  const url = env.FLEET_HUB_URL?.trim().replace(/\/+$/, "");
  const token = env.FLEET_HUB_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export interface FleetCredential {
  readonly username: string | null;
  readonly password: string | null;
}

export type CredentialSource = (url: string) => Promise<FleetCredential | null>;

export function hubCredentialSource(
  hub: FleetHubConfig,
  fetchImpl: typeof fetch = fetch,
): CredentialSource {
  return async (url) => {
    const response = await fetchImpl(`${hub.url}/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${hub.token}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as FleetCredential | null;
    return body && (body.username || body.password) ? body : null;
  };
}

/** Remembers when each site last prompted the phone. */
export function makeAskGate(now: () => number = Date.now) {
  const asked = new Map<string, number>();
  return (url: string) => {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    if (origin === "null" || !/^https?:$/.test(new URL(url).protocol)) return false;
    const last = asked.get(origin);
    if (last !== undefined && now() - last < ASK_INTERVAL_MS) return false;
    asked.set(origin, now());
    return true;
  };
}

const sharedGate = makeAskGate();

/** Adds credential fill to one page or frame session. Call after Page.enable. */
export async function installFleetCredentials(
  cdp: CDPSession,
  source: CredentialSource | null = (() => {
    const hub = fleetHubConfig();
    return hub ? hubCredentialSource(hub) : null;
  })(),
  gate: (url: string) => boolean = sharedGate,
) {
  if (!source) return;
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.addBinding", { name: BINDING, executionContextName: WORLD });
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: FLEET_CREDENTIAL_SCRIPT,
    worldName: WORLD,
    runImmediately: true,
  });
  cdp.on("Runtime.bindingCalled", (event) => {
    if (event.name !== BINDING) return;
    let url: string;
    try {
      url = String((JSON.parse(event.payload) as { url?: unknown }).url ?? "");
    } catch {
      return;
    }
    if (!gate(url)) return;
    void source(url).then((credential) => {
      if (!credential) return;
      return cdp
        .send("Runtime.evaluate", {
          contextId: event.executionContextId,
          expression: `globalThis.__t3FleetFill(${JSON.stringify(credential.username)}, ${JSON.stringify(credential.password)})`,
          returnByValue: true,
        })
        .catch(() => undefined);
    });
  });
}
