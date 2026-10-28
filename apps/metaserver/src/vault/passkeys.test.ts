import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import { verifyRegistrationResponse } from "@simplewebauthn/server";

import { assertPasskey, cbor, createPasskey, rpIdAllowed } from "./passkeys.ts";

const origin = "https://login.example.com";
const challenge = Buffer.from("registration-challenge").toString("base64url");

describe("passkeys", () => {
  it("encodes canonical CBOR", () => {
    expect(
      cbor(
        new Map<never, never>([
          [-1 as never, 1 as never],
          [3 as never, -7 as never],
          [1 as never, 2 as never],
        ]),
      ).toString("hex"),
    ).toBe("a3010203262001");
    expect(cbor("fmt").toString("hex")).toBe("63666d74");
  });

  it("only allows the page's host or a parent domain, on secure origins", () => {
    expect(rpIdAllowed("example.com", "https://login.example.com")).toBe(true);
    expect(rpIdAllowed("login.example.com", "https://login.example.com")).toBe(true);
    expect(rpIdAllowed("other.com", "https://login.example.com")).toBe(false);
    expect(rpIdAllowed("com", "https://example.com")).toBe(false);
    expect(rpIdAllowed("example.com", "http://example.com")).toBe(false);
    expect(rpIdAllowed("localhost", "http://localhost:3000")).toBe(true);
  });

  it("registers and signs in in a way a real relying party accepts", async () => {
    const { record, response } = createPasskey({
      origin,
      rpId: "example.com",
      challenge,
      user: { id: Buffer.from("user-1").toString("base64url"), name: "alice" },
    });
    const registration = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: "example.com",
      requireUserVerification: true,
    });
    expect(registration.verified).toBe(true);
    expect(registration.registrationInfo?.credentialBackedUp).toBe(true);
    expect(registration.registrationInfo?.credentialDeviceType).toBe("multiDevice");

    const loginChallenge = Buffer.from("login-challenge").toString("base64url");
    const assertion = assertPasskey(record, { origin, challenge: loginChallenge });
    // What a relying party checks: the signature over authenticatorData || SHA-256(clientDataJSON)
    // with the registered key, the rpId hash, the flags and the challenge.
    const authData = Buffer.from(assertion.response.authenticatorData, "base64url");
    const clientDataJSON = Buffer.from(assertion.response.clientDataJSON, "base64url");
    const signed = Buffer.concat([
      authData,
      NodeCrypto.createHash("sha256").update(clientDataJSON).digest(),
    ]);
    const publicKey = NodeCrypto.createPublicKey({
      key: Buffer.from(response.response.publicKey, "base64url"),
      format: "der",
      type: "spki",
    });
    expect(
      NodeCrypto.verify(
        "sha256",
        signed,
        publicKey,
        Buffer.from(assertion.response.signature, "base64url"),
      ),
    ).toBe(true);
    expect(authData.subarray(0, 32)).toEqual(
      NodeCrypto.createHash("sha256").update("example.com").digest(),
    );
    expect(authData[32]).toBe(0x1d);
    expect(JSON.parse(clientDataJSON.toString())).toEqual({
      type: "webauthn.get",
      challenge: loginChallenge,
      origin,
      crossOrigin: false,
    });
    expect(assertion.id).toBe(registration.registrationInfo!.credential.id);
    expect(assertion.response.userHandle).toBe(Buffer.from("user-1").toString("base64url"));
  });
});
