// @effect-diagnostics globalFetch:off globalDate:off - Runs inside Playwright's promise-based CDP callbacks.
import type { CDPSession } from "playwright-core";

/**
 * Fork: an isolated-world script spots a login form per frame and calls a CDP binding; the t3
 * metaserver asks the phone and an approved login is filled and submitted. Off unless the
 * installer set T3_METASERVER_URL and T3_METASERVER_TOKEN in the service environment.
 */

const WORLD = "t3-fleet-credentials";
const BINDING = "__t3FleetCredentials";
const PASSKEY_BINDING = "__t3FleetPasskey";
/** One phone prompt per site per window, however often the page re-renders its form. */
const ASK_INTERVAL_MS = 2 * 60_000;
/** The metaserver waits up to two minutes for the phone. */
const METASERVER_TIMEOUT_MS = 150_000;

const FLEET_CREDENTIAL_SCRIPT = `(() => {
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

/**
 * Main world, by design: sites call navigator.credentials themselves. The page can call the
 * binding too, but the server takes the origin from the execution context, not the payload.
 */
const FLEET_PASSKEY_SCRIPT = `(() => {
  const binding = globalThis.${PASSKEY_BINDING};
  if (typeof binding !== "function" || !navigator.credentials || globalThis.__t3FleetPasskeyResolve) return;
  delete globalThis.${PASSKEY_BINDING};
  const pending = new Map();
  let next = 0;
  const bytes = (value) => value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  const b64u = (value) => btoa(String.fromCharCode(...bytes(value))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  const unb64u = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)).buffer;
  Object.defineProperty(globalThis, "__t3FleetPasskeyResolve", {
    value: (id, result) => {
      const entry = pending.get(id);
      pending.delete(id);
      if (!entry) return;
      if (!result) return entry.reject(new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"));
      entry.resolve(toCredential(result, entry.create));
    },
  });
  const toCredential = (result, create) => {
    const r = result.response;
    const response = create
      ? {
          clientDataJSON: unb64u(r.clientDataJSON),
          attestationObject: unb64u(r.attestationObject),
          getTransports: () => [...r.transports],
          getAuthenticatorData: () => unb64u(r.authenticatorData),
          getPublicKey: () => unb64u(r.publicKey),
          getPublicKeyAlgorithm: () => r.publicKeyAlgorithm,
        }
      : {
          clientDataJSON: unb64u(r.clientDataJSON),
          authenticatorData: unb64u(r.authenticatorData),
          signature: unb64u(r.signature),
          userHandle: r.userHandle ? unb64u(r.userHandle) : null,
        };
    Object.setPrototypeOf(response, (create ? AuthenticatorAttestationResponse : AuthenticatorAssertionResponse).prototype);
    const credential = {
      id: result.id,
      rawId: unb64u(result.rawId),
      type: "public-key",
      authenticatorAttachment: "platform",
      response,
      getClientExtensionResults: () => ({}),
      toJSON: () => result,
    };
    Object.setPrototypeOf(credential, PublicKeyCredential.prototype);
    return credential;
  };
  const ask = (create, payload, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    const id = ++next;
    pending.set(id, { resolve, reject, create });
    signal?.addEventListener("abort", () => {
      if (pending.delete(id)) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    });
    binding(JSON.stringify({ id, op: create ? "create" : "get", ...payload }));
  });
  const container = navigator.credentials;
  const create = container.create.bind(container);
  const get = container.get.bind(container);
  container.create = (options) => {
    const key = options?.publicKey;
    if (!key) return create(options);
    return ask(true, {
      rpId: key.rp?.id ?? location.hostname,
      challenge: b64u(key.challenge),
      user: { id: b64u(key.user.id), name: key.user.name, displayName: key.user.displayName },
    }, options.signal);
  };
  container.get = (options) => {
    const key = options?.publicKey;
    if (!key) return get(options);
    // Conditional (autofill) requests wait for a modal one instead.
    if (options.mediation === "conditional") return new Promise(() => {});
    return ask(false, {
      rpId: key.rpId ?? location.hostname,
      challenge: b64u(key.challenge),
      allowCredentials: (key.allowCredentials ?? []).map((entry) => b64u(entry.id)),
    }, options.signal);
  };
  if (globalThis.PublicKeyCredential) {
    PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = () => Promise.resolve(true);
    PublicKeyCredential.isConditionalMediationAvailable = () => Promise.resolve(false);
  }
})()`;

export interface MetaserverConfig {
  readonly url: string;
  readonly token: string;
}

export function metaserverConfig(env: NodeJS.ProcessEnv = process.env): MetaserverConfig | null {
  const url = env.T3_METASERVER_URL?.trim().replace(/\/+$/, "");
  const token = env.T3_METASERVER_TOKEN?.trim();
  return url && token ? { url, token } : null;
}

export interface FleetCredential {
  readonly username: string | null;
  readonly password: string | null;
}

export type CredentialSource = (url: string) => Promise<FleetCredential | null>;

/** Answers a page's WebAuthn call; `origin` comes from the frame, never the page. */
export type PasskeySource = (
  op: "create" | "get",
  request: Record<string, unknown> & { origin: string },
) => Promise<unknown | null>;

function metaserverPasskeySource(
  metaserver: MetaserverConfig,
  fetchImpl: typeof fetch = fetch,
): PasskeySource {
  return async (op, request) => {
    const response = await fetchImpl(`${metaserver.url}/passkeys/${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${metaserver.token}`, "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(METASERVER_TIMEOUT_MS),
    }).catch(() => null);
    if (!response?.ok) return null;
    return response.json().catch(() => null);
  };
}

export function metaserverCredentialSource(
  metaserver: MetaserverConfig,
  fetchImpl: typeof fetch = fetch,
): CredentialSource {
  return async (url) => {
    const response = await fetchImpl(`${metaserver.url}/credentials`, {
      method: "POST",
      headers: { authorization: `Bearer ${metaserver.token}`, "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(METASERVER_TIMEOUT_MS),
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
    const metaserver = metaserverConfig();
    return metaserver ? metaserverCredentialSource(metaserver) : null;
  })(),
  gate: (url: string) => boolean = sharedGate,
  passkeys: PasskeySource | null = (() => {
    const metaserver = metaserverConfig();
    return metaserver ? metaserverPasskeySource(metaserver) : null;
  })(),
) {
  if (!source && !passkeys) return;
  // Main-world contexts by id, so a passkey request is tied to its frame's real origin.
  const origins = new Map<number, string>();
  cdp.on("Runtime.executionContextCreated", ({ context }) => {
    if ((context.auxData as { isDefault?: boolean } | undefined)?.isDefault)
      origins.set(context.id, context.origin);
  });
  cdp.on("Runtime.executionContextDestroyed", ({ executionContextId }) =>
    origins.delete(executionContextId),
  );
  cdp.on("Runtime.executionContextsCleared", () => origins.clear());
  await cdp.send("Runtime.enable");
  if (passkeys) {
    await cdp.send("Runtime.addBinding", { name: PASSKEY_BINDING });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: FLEET_PASSKEY_SCRIPT,
      runImmediately: true,
    });
    cdp.on("Runtime.bindingCalled", (event) => {
      if (event.name !== PASSKEY_BINDING) return;
      const origin = origins.get(event.executionContextId);
      let payload: Record<string, unknown> & { id?: unknown; op?: unknown };
      try {
        payload = JSON.parse(event.payload) as typeof payload;
      } catch {
        return;
      }
      const { id, op, ...request } = payload;
      if (typeof id !== "number" || (op !== "create" && op !== "get")) return;
      const answer = origin ? passkeys(op, { ...request, origin }) : Promise.resolve(null);
      void answer
        .catch(() => null)
        .then((result) =>
          cdp
            .send("Runtime.evaluate", {
              contextId: event.executionContextId,
              expression: `globalThis.__t3FleetPasskeyResolve(${id}, ${JSON.stringify(result ?? null)})`,
            })
            .catch(() => undefined),
        );
    });
  }
  if (!source) return;
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
