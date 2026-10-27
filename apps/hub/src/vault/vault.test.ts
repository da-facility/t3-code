import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { HubDb } from "../db.ts";
import { generateKeyPair, INFO_UNLOCK, INFO_WRAPPED_KEY, open, seal } from "./hpke.ts";
import { OpCli } from "./op.ts";
import { Vault } from "./vault.ts";

const OP_STUB = NodePath.resolve(import.meta.dirname, "../../../../scripts/fleet/op-stub.mjs");
const PASSWORD = "correct horse battery staple";
const encode = (text: string) => new TextEncoder().encode(text);

/** A phone with a software key standing in for the Secure Enclave. */
async function makePhone(db: HubDb, name: string) {
  const { device } = db.enrollDevice(name, null);
  const { keyPair, publicKey } = await generateKeyPair();
  db.setDevicePublicKey(device.id, publicKey);
  return {
    id: device.id,
    async unlock(vault: Vault) {
      const challenge = await vault.startUnlock(device.id);
      const key = await open(keyPair, challenge.wrappedKey, INFO_WRAPPED_KEY, encode(device.id));
      const sealedKey = await seal(
        challenge.publicKey,
        key,
        INFO_UNLOCK,
        encode(challenge.challengeId),
      );
      return vault.finishUnlock(device.id, challenge.challengeId, sealedKey);
    },
  };
}

function setup() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fleet-vault-test-"));
  const env = { ...process.env, OP_STUB_HOME: NodePath.join(dir, "op") };
  const stub = (args: string[], input?: string) =>
    NodeChildProcess.execFileSync(process.execPath, [OP_STUB, ...args], {
      env,
      input,
      encoding: "utf8",
    });
  stub(
    [
      "account",
      "add",
      "--address",
      "my.1password.example",
      "--email",
      "user@example.com",
      "--secret-key",
      "A3-TEST",
      "--shorthand",
      "my",
    ],
    PASSWORD,
  );
  stub([
    "__seed",
    JSON.stringify([
      {
        id: "item1",
        title: "Example",
        url: "https://example.com",
        username: "alice",
        password: "s3cret",
      },
    ]),
  ]);
  const db = new HubDb(NodePath.join(dir, "hub.sqlite"));
  let now = 1_000_000;
  const vault = new Vault(db, new OpCli(process.execPath, "my", env), {
    now: () => now,
    heartbeatTimeoutMs: 30_000,
  });
  // OpCli runs `node op-stub.mjs ...`; prefix the script as the first argument.
  const op = (vault as unknown as { op: OpCli }).op;
  const run = (
    op as unknown as { run: (args: string[], input?: string) => Promise<string> }
  ).run.bind(op);
  (op as unknown as { run: typeof run }).run = (args, input) => run([OP_STUB, ...args], input);
  return {
    db,
    vault,
    stub,
    advance: (ms: number) => {
      now += ms;
    },
    sessions: () =>
      (
        JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "op", "state.json"), "utf8")) as {
          sessions: unknown[];
        }
      ).sessions.length,
    [Symbol.dispose]() {
      void vault.lock("test end");
      db.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("vault", () => {
  it("unlocks with the phone's key, signs in to 1Password and fills after approval", async () => {
    using h = setup();
    const phone = await makePhone(h.db, "phone");
    const { recoveryCode, wrappedFor } = await h.vault.setup(PASSWORD, "my");
    expect(recoveryCode).toMatch(/^([0-9A-Z]{4}-){12}[0-9A-Z]{1,4}$/);
    expect(wrappedFor).toEqual([phone.id]);
    // Setup proves the password, then signs out again.
    expect(h.sessions()).toBe(0);

    expect(await phone.unlock(h.vault)).toMatchObject({
      unlocked: true,
      unlockedByThisDevice: true,
    });
    expect(h.sessions()).toBe(1);

    const pending = h.vault.requestCredential("https://www.example.com/login", "host-a");
    const [request] = h.vault.listRequests();
    expect(request).toMatchObject({ url: "https://www.example.com/login", requester: "host-a" });
    expect((await h.vault.refreshOptions(request!.id))?.options).toEqual([
      { id: "item1", title: "Example" },
    ]);
    await h.vault.decide(request!.id, phone.id, true);
    expect(await pending).toEqual({
      id: "item1",
      title: "Example",
      username: "alice",
      password: "s3cret",
    });
  });

  it("denies a request the phone declines", async () => {
    using h = setup();
    const phone = await makePhone(h.db, "phone");
    await h.vault.setup(PASSWORD, "my");
    await phone.unlock(h.vault);
    const pending = h.vault.requestCredential("https://example.com", "host-a");
    await h.vault.decide(h.vault.listRequests()[0]!.id, phone.id, false);
    expect(await pending).toBeNull();
  });

  it("locks and signs out of op when the heartbeat stops", async () => {
    using h = setup();
    const phone = await makePhone(h.db, "phone");
    await h.vault.setup(PASSWORD, "my");
    await phone.unlock(h.vault);
    h.advance(20_000);
    expect(h.vault.heartbeat(phone.id)).toBe(true);
    h.advance(20_000);
    await h.vault.checkHeartbeat();
    expect(h.vault.status().unlocked).toBe(true);
    h.advance(31_000);
    await h.vault.checkHeartbeat();
    expect(h.vault.status().unlocked).toBe(false);
    expect(h.sessions()).toBe(0);
    // The account stays added: the next sign-in is not a new device.
    expect(h.stub(["signin", "--raw", "--account", "my"], PASSWORD).trim().length).toBeGreaterThan(
      20,
    );
  });

  it("wraps the key for a newly approved phone at the next unlock, rotates it after a revocation", async () => {
    using h = setup();
    const phone = await makePhone(h.db, "phone");
    const { recoveryCode } = await h.vault.setup(PASSWORD, "my");
    const tablet = await makePhone(h.db, "tablet");
    h.db.approveDevice(tablet.id, phone.id);
    expect(h.vault.wrappedKeyFor(tablet.id)).toBeNull();
    await expect(tablet.unlock(h.vault)).rejects.toThrow(/no vault key yet/);

    await phone.unlock(h.vault);
    expect(h.vault.wrappedKeyFor(tablet.id)).not.toBeNull();
    await h.vault.lock("test");
    await tablet.unlock(h.vault);
    await h.vault.lock("test");

    const before = h.vault.wrappedKeyFor(phone.id);
    h.db.revokeDevice(tablet.id);
    h.vault.onDeviceRevoked(tablet.id);
    expect(h.vault.wrappedKeyFor(tablet.id)).toBeNull();
    expect(h.vault.status().rotationPending).toBe(true);

    await phone.unlock(h.vault);
    expect(h.vault.status().rotationPending).toBe(false);
    expect(h.vault.wrappedKeyFor(phone.id)).not.toEqual(before);
    await h.vault.lock("test");
    // The rotated key still opens the vault, and the recovery code still works.
    await phone.unlock(h.vault);
    await h.vault.lock("test");
    expect((await h.vault.recover(recoveryCode)).wrappedFor).toEqual([phone.id]);
    await expect(h.vault.recover(recoveryCode.replace(/^.{4}/, "0000"))).rejects.toThrow(
      /does not match/,
    );
  });

  it("refuses a key that does not open the vault", async () => {
    using h = setup();
    const phone = await makePhone(h.db, "phone");
    await h.vault.setup(PASSWORD, "my");
    const challenge = await h.vault.startUnlock(phone.id);
    const forged = await seal(
      challenge.publicKey,
      new Uint8Array(32),
      INFO_UNLOCK,
      encode(challenge.challengeId),
    );
    await expect(h.vault.finishUnlock(phone.id, challenge.challengeId, forged)).rejects.toThrow(
      /did not open/,
    );
    expect(h.vault.status().unlocked).toBe(false);
  });
});
