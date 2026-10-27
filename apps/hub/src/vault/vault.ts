import * as NodeCrypto from "node:crypto";

import type { HubDb } from "../db.ts";
import {
  generateKeyPair,
  INFO_UNLOCK,
  INFO_WRAPPED_KEY,
  open,
  type Sealed,
  seal,
  suite,
} from "./hpke.ts";
import { matchLogins, type OpCli, type OpCredential } from "./op.ts";
import { assertPasskey, createPasskey, type PasskeyRecord } from "./passkeys.ts";

/**
 * The 1Password master password, encrypted with a vault key K the hub never stores.
 * Phones hold K wrapped to their Secure Enclave key; a recovery code wraps it too.
 * An unlock brings K and an op session into memory while the phone sends heartbeats.
 */

const RECORD_KEY = "vault";
const PASSKEY_PREFIX = "passkey.";

interface StoredPasskey {
  credentialId: string;
  rpId: string;
  userName: string;
  createdAt: string;
  /** The full PasskeyRecord, private key included, encrypted with K. */
  sealed: { iv: string; ct: string; tag: string };
}
const wrappedKeyKey = (deviceId: string) => `vault.wrapped.${deviceId}`;

interface VaultRecord {
  version: 1;
  account: string | null;
  password: { iv: string; ct: string; tag: string };
  recoveryPublicKey: string;
  recoveryWrap: Sealed;
  rotationPending: boolean;
  createdAt: string;
  rotatedAt: string | null;
}

export type CredentialRequestKind = "login" | "passkey-create" | "passkey-get";

export interface CredentialRequest {
  id: string;
  kind: CredentialRequestKind;
  /** What the phone asks, e.g. "Create a passkey for example.com as alice". */
  title: string;
  url: string;
  requester: string;
  createdAt: number;
  options: Array<{ id: string; title: string }>;
  state: "waiting" | "approved" | "denied" | "expired";
}

export class VaultError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function encodeRecoveryCode(bytes: Uint8Array) {
  let bits = "";
  for (const byte of bytes) bits += byte.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i < bits.length; i += 5)
    out += CROCKFORD[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return out.match(/.{1,4}/g)!.join("-");
}

export function decodeRecoveryCode(code: string): Uint8Array {
  const clean = code
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  let bits = "";
  for (const char of clean) {
    const value = CROCKFORD.indexOf(char);
    if (value === -1) throw new VaultError(400, "That is not a recovery code.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(32);
  if (bits.length < 256) throw new VaultError(400, "That recovery code is too short.");
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

async function recoveryKeyPair(code: Uint8Array) {
  const keyPair = await suite.kem.deriveKeyPair(new Uint8Array(code).buffer);
  const publicKey = Buffer.from(await suite.kem.serializePublicKey(keyPair.publicKey)).toString(
    "base64",
  );
  return { keyPair, publicKey };
}

function encryptPassword(key: Buffer, password: string) {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    ct: ct.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
  };
}

function decryptPassword(key: Buffer, sealed: VaultRecord["password"]) {
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

interface Session {
  key: Buffer;
  opToken: string;
  deviceId: string;
  heartbeatDeadline: number;
  unlockedAt: number;
}

export interface VaultOptions {
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  now?: () => number;
  /** Tells phones a request is waiting (push). */
  notify?: (request: CredentialRequest, locked: boolean) => void;
}

export class Vault {
  private readonly db: HubDb;
  private readonly op: OpCli;
  private readonly heartbeatTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly now: () => number;
  private readonly notify: VaultOptions["notify"];
  private session: Session | null = null;
  private challenges = new Map<
    string,
    { deviceId: string; keyPair: CryptoKeyPair; expiresAt: number }
  >();
  private requests = new Map<
    string,
    CredentialRequest & { resolve: (decision: { itemId: string } | null) => void }
  >();
  private watchdog: NodeJS.Timeout | null = null;

  constructor(db: HubDb, op: OpCli, options: VaultOptions = {}) {
    this.db = db;
    this.op = op;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.notify = options.notify;
  }

  private record(): VaultRecord | null {
    const raw = this.db.getKv(RECORD_KEY);
    return raw ? (JSON.parse(raw) as VaultRecord) : null;
  }

  private saveRecord(record: VaultRecord) {
    this.db.setKv(RECORD_KEY, JSON.stringify(record));
  }

  wrappedKeyFor(deviceId: string): Sealed | null {
    const raw = this.db.getKv(wrappedKeyKey(deviceId));
    return raw ? (JSON.parse(raw) as Sealed) : null;
  }

  /** Wraps K for every approved phone that has a key but no wrapped copy (or for all, after a rotation). */
  private async wrapForDevices(key: Buffer, all: boolean) {
    const wrapped: string[] = [];
    for (const device of this.db.listDevices()) {
      if (device.status !== "approved" || !device.publicKey) continue;
      if (!all && this.wrappedKeyFor(device.id)) continue;
      const sealed = await seal(
        device.publicKey,
        key,
        INFO_WRAPPED_KEY,
        new TextEncoder().encode(device.id),
      );
      this.db.setKv(wrappedKeyKey(device.id), JSON.stringify(sealed));
      wrapped.push(device.id);
    }
    return wrapped;
  }

  status(deviceId?: string) {
    const record = this.record();
    return {
      configured: record !== null,
      unlocked: this.session !== null,
      unlockedByThisDevice: this.session !== null && this.session.deviceId === deviceId,
      rotationPending: record?.rotationPending ?? false,
      hasWrappedKey: deviceId ? this.wrappedKeyFor(deviceId) !== null : false,
      pendingRequests: [...this.requests.values()].filter((request) => request.state === "waiting")
        .length,
    };
  }

  /** One-time setup on the hub. Returns the recovery code, which is never stored. */
  async setup(password: string, account: string | null) {
    if (this.record())
      throw new VaultError(409, "The vault is already set up. Use `vault reset` first.");
    const key = NodeCrypto.randomBytes(32);
    try {
      // Fail early if the password does not open the account.
      await this.op.signin(password);
      await this.op.signout();
      const code = new Uint8Array(NodeCrypto.randomBytes(32));
      const recovery = await recoveryKeyPair(code);
      this.saveRecord({
        version: 1,
        account,
        password: encryptPassword(key, password),
        recoveryPublicKey: recovery.publicKey,
        recoveryWrap: await seal(
          recovery.publicKey,
          key,
          INFO_WRAPPED_KEY,
          new TextEncoder().encode("recovery"),
        ),
        rotationPending: false,
        createdAt: new Date(this.now()).toISOString(),
        rotatedAt: null,
      });
      const wrapped = await this.wrapForDevices(key, true);
      return { recoveryCode: encodeRecoveryCode(code), wrappedFor: wrapped };
    } finally {
      key.fill(0);
    }
  }

  /** Opens K with the recovery code and re-wraps it for every approved phone with a key. */
  async recover(code: string) {
    const record = this.record();
    if (!record) throw new VaultError(404, "The vault is not set up.");
    const recovery = await recoveryKeyPair(decodeRecoveryCode(code));
    if (recovery.publicKey !== record.recoveryPublicKey)
      throw new VaultError(403, "That recovery code does not match this vault.");
    const key = Buffer.from(
      await open(
        recovery.keyPair,
        record.recoveryWrap,
        INFO_WRAPPED_KEY,
        new TextEncoder().encode("recovery"),
      ),
    );
    try {
      return { wrappedFor: await this.wrapForDevices(key, true) };
    } finally {
      key.fill(0);
    }
  }

  reset() {
    void this.lock("reset");
    this.db.setKv(RECORD_KEY, null);
    for (const device of this.db.listDevices()) this.db.setKv(wrappedKeyKey(device.id), null);
  }

  /** A revoked phone's wrapped key is deleted, and K rotates at the next unlock. */
  onDeviceRevoked(deviceId: string) {
    this.db.setKv(wrappedKeyKey(deviceId), null);
    const record = this.record();
    if (record) this.saveRecord({ ...record, rotationPending: true });
    if (this.session?.deviceId === deviceId) void this.lock("device revoked");
  }

  /** The device's key changed (a new Secure Enclave key); its old wrapped copy is useless. */
  onDeviceKeyChanged(deviceId: string) {
    this.db.setKv(wrappedKeyKey(deviceId), null);
  }

  async startUnlock(deviceId: string) {
    if (!this.record()) throw new VaultError(404, "The vault is not set up on the hub yet.");
    if (!this.wrappedKeyFor(deviceId)) {
      throw new VaultError(
        409,
        "This phone has no vault key yet. Unlock once from another phone, or recover with the code.",
      );
    }
    for (const [id, challenge] of this.challenges)
      if (challenge.expiresAt < this.now()) this.challenges.delete(id);
    const { keyPair, publicKey } = await generateKeyPair();
    const challengeId = NodeCrypto.randomUUID();
    const expiresAt = this.now() + 60_000;
    this.challenges.set(challengeId, { deviceId, keyPair, expiresAt });
    return { challengeId, publicKey, wrappedKey: this.wrappedKeyFor(deviceId)!, expiresAt };
  }

  async finishUnlock(deviceId: string, challengeId: string, sealedKey: Sealed) {
    const challenge = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!challenge || challenge.deviceId !== deviceId || challenge.expiresAt < this.now()) {
      throw new VaultError(410, "That unlock request expired. Try again.");
    }
    const record = this.record();
    if (!record) throw new VaultError(404, "The vault is not set up.");
    let key: Buffer;
    try {
      key = Buffer.from(
        await open(
          challenge.keyPair,
          sealedKey,
          INFO_UNLOCK,
          new TextEncoder().encode(challengeId),
        ),
      );
    } catch {
      throw new VaultError(400, "The phone's answer could not be opened.");
    }
    let password: string;
    try {
      password = decryptPassword(key, record.password);
    } catch {
      key.fill(0);
      throw new VaultError(403, "The vault key did not open the vault.");
    }
    let opToken: string;
    try {
      opToken = await this.op.signin(password);
    } catch (error) {
      key.fill(0);
      throw new VaultError(
        502,
        `1Password sign-in failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      password = "";
    }
    if (this.session) this.session.key.fill(0);
    this.session = {
      key,
      opToken,
      deviceId,
      heartbeatDeadline: this.now() + this.heartbeatTimeoutMs,
      unlockedAt: this.now(),
    };
    this.startWatchdog();

    if (record.rotationPending) await this.rotate(record);
    else await this.wrapForDevices(key, false);
    return this.status(deviceId);
  }

  private async rotate(record: VaultRecord) {
    const session = this.session!;
    const plaintext = decryptPassword(session.key, record.password);
    const next = NodeCrypto.randomBytes(32);
    this.saveRecord({
      ...record,
      password: encryptPassword(next, plaintext),
      recoveryWrap: await seal(
        record.recoveryPublicKey,
        next,
        INFO_WRAPPED_KEY,
        new TextEncoder().encode("recovery"),
      ),
      rotationPending: false,
      rotatedAt: new Date(this.now()).toISOString(),
    });
    for (const { key, value } of this.db.listKv(PASSKEY_PREFIX)) {
      const stored = JSON.parse(value) as StoredPasskey;
      const plain = decryptPassword(session.key, stored.sealed);
      this.db.setKv(key, JSON.stringify({ ...stored, sealed: encryptPassword(next, plain) }));
    }
    session.key.fill(0);
    session.key = next;
    await this.wrapForDevices(next, true);
  }

  heartbeat(deviceId: string) {
    if (!this.session || this.session.deviceId !== deviceId) return false;
    this.session.heartbeatDeadline = this.now() + this.heartbeatTimeoutMs;
    return true;
  }

  private startWatchdog() {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => void this.checkHeartbeat(), 1_000);
    this.watchdog.unref();
  }

  /** Locks when the phone's approval screen stopped sending heartbeats. Exposed for tests. */
  checkHeartbeat(): Promise<void> {
    if (this.session && this.now() > this.session.heartbeatDeadline) {
      return this.lock("heartbeat missed");
    }
    return Promise.resolve();
  }

  async lock(_reason: string) {
    const session = this.session;
    this.session = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const request of this.requests.values()) {
      if (request.state === "waiting") {
        request.state = "denied";
        request.resolve(null);
      }
    }
    if (session) {
      session.key.fill(0);
      session.opToken = "";
      await this.op.signout();
    }
  }

  listRequests() {
    const now = this.now();
    for (const request of this.requests.values()) {
      if (request.state === "waiting" && now - request.createdAt > this.requestTimeoutMs) {
        request.state = "expired";
        request.resolve(null);
      }
    }
    return [...this.requests.values()]
      .filter((request) => request.state === "waiting")
      .map(({ resolve: _resolve, ...request }) => request);
  }

  /**
   * Asks the phone to approve one credential use and waits for the answer.
   * Resolves null when denied, timed out or locked.
   */
  /** Waits for the phone's answer to one request: the chosen option id, or null. */
  private ask(
    kind: CredentialRequestKind,
    url: string,
    requester: string,
    title: string,
    options: Array<{ id: string; title: string }>,
  ) {
    if (!this.record()) throw new VaultError(404, "The vault is not set up.");
    const id = NodeCrypto.randomUUID();
    const decision = new Promise<{ itemId: string } | null>((resolve) => {
      const request = {
        id,
        kind,
        title,
        url,
        requester,
        createdAt: this.now(),
        options,
        state: "waiting" as const,
        resolve,
      };
      this.requests.set(id, request);
      this.notify?.(request, this.session === null);
      setTimeout(() => {
        if (request.state === "waiting") {
          (request as CredentialRequest).state = "expired";
          resolve(null);
        }
      }, this.requestTimeoutMs).unref();
    });
    if (kind === "login") void this.refreshOptions(id).catch(() => {});
    return decision.finally(() => this.requests.delete(id));
  }

  /** Asks the phone to approve one login fill. Resolves null when denied, timed out or locked. */
  async requestCredential(url: string, requester: string): Promise<OpCredential | null> {
    let host = url;
    try {
      host = new URL(url).host;
    } catch {}
    const answer = await this.ask("login", url, requester, `Sign in to ${host}`, []);
    if (!answer || !this.session) return null;
    return this.op.credential(this.session.opToken, answer.itemId);
  }

  private storedPasskeys(rpId: string): StoredPasskey[] {
    return this.db
      .listKv(PASSKEY_PREFIX)
      .map(({ value }) => JSON.parse(value) as StoredPasskey)
      .filter((passkey) => passkey.rpId === rpId);
  }

  /** Creates a passkey after the phone approves; stored encrypted with the vault key. */
  async requestPasskeyCreate(input: {
    origin: string;
    rpId: string;
    challenge: string;
    user: { id: string; name: string; displayName?: string };
    requester: string;
  }) {
    const title = `Create a passkey for ${input.rpId} as ${input.user.name}`;
    const answer = await this.ask("passkey-create", input.origin, input.requester, title, [
      { id: "create", title: "Create passkey" },
    ]);
    if (!answer || !this.session) return null;
    const { record, response } = createPasskey(input);
    const stored: StoredPasskey = {
      credentialId: record.credentialId,
      rpId: record.rpId,
      userName: record.userName,
      createdAt: record.createdAt,
      sealed: encryptPassword(this.session.key, JSON.stringify(record)),
    };
    this.db.setKv(`${PASSKEY_PREFIX}${record.credentialId}`, JSON.stringify(stored));
    return response;
  }

  /** Signs in with a stored passkey the phone picks. */
  async requestPasskeyGet(input: {
    origin: string;
    rpId: string;
    challenge: string;
    allowCredentials: string[];
    requester: string;
  }) {
    const candidates = this.storedPasskeys(input.rpId).filter(
      (passkey) =>
        input.allowCredentials.length === 0 ||
        input.allowCredentials.includes(passkey.credentialId),
    );
    if (candidates.length === 0) return null;
    const answer = await this.ask(
      "passkey-get",
      input.origin,
      input.requester,
      `Sign in to ${input.rpId} with a passkey`,
      candidates.map((passkey) => ({ id: passkey.credentialId, title: passkey.userName })),
    );
    if (!answer || !this.session) return null;
    const stored = candidates.find((passkey) => passkey.credentialId === answer.itemId);
    if (!stored) return null;
    const record = JSON.parse(decryptPassword(this.session.key, stored.sealed)) as PasskeyRecord;
    return assertPasskey(record, input);
  }

  private async loginOptions(url: string) {
    if (!this.session) return [];
    return matchLogins(await this.op.logins(this.session.opToken), url).map((login) => ({
      id: login.id,
      title: login.title,
    }));
  }

  /** The phone's answer to a request; approval needs the vault unlocked. */
  async decide(requestId: string, deviceId: string, approve: boolean, itemId?: string) {
    const request = this.requests.get(requestId);
    if (!request || request.state !== "waiting") throw new VaultError(404, "That request is gone.");
    if (!approve) {
      request.state = "denied";
      request.resolve(null);
      return;
    }
    if (!this.session || this.session.deviceId !== deviceId)
      throw new VaultError(409, "Unlock the vault on this phone first.");
    if (request.kind === "login" && request.options.length === 0) {
      request.options = await this.loginOptions(request.url);
    }
    const chosen = itemId ?? (request.options.length === 1 ? request.options[0]!.id : null);
    if (!chosen || !request.options.some((option) => option.id === chosen)) {
      throw new VaultError(
        400,
        request.options.length === 0
          ? "No 1Password login matches this site."
          : "Pick which login to use.",
      );
    }
    request.state = "approved";
    request.resolve({ itemId: chosen });
  }

  /** Refreshes a waiting request's login choices once the vault is unlocked. */
  async refreshOptions(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) return null;
    if (request.state === "waiting" && this.session)
      request.options = await this.loginOptions(request.url);
    const { resolve: _resolve, ...visible } = request;
    return visible;
  }
}
