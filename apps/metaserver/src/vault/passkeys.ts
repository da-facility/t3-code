import * as NodeCrypto from "node:crypto";

/**
 * A software WebAuthn authenticator for the metaserver: ES256 passkeys with "none"
 * attestation and the backup flags set (BE/BS), as a synced passkey would have.
 * Pure: storage and approval live in the vault.
 */

export interface PasskeyRecord {
  credentialId: string;
  rpId: string;
  userHandle: string;
  userName: string;
  /** PKCS#8 DER, base64. The vault encrypts the record before storing it. */
  privateKey: string;
  createdAt: string;
}

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text: string) => Buffer.from(text, "base64url");
const sha256 = (data: Uint8Array | string) => NodeCrypto.createHash("sha256").update(data).digest();

// Minimal CBOR (RFC 8949) for attestation objects and COSE keys.
type Cbor = number | string | Uint8Array | Map<Cbor, Cbor> | Cbor[];
function cborHead(major: number, value: number) {
  if (value < 24) return Buffer.from([(major << 5) | value]);
  if (value < 0x100) return Buffer.from([(major << 5) | 24, value]);
  if (value < 0x10000) return Buffer.from([(major << 5) | 25, value >> 8, value & 0xff]);
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(value, 1);
  return head;
}
export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)]);
  const entries = [...value.entries()].map(([key, item]) => [cbor(key), cbor(item)] as const);
  // Canonical CBOR: keys sorted by their encoded bytes, shorter first.
  entries.sort(([a], [b]) => a.length - b.length || Buffer.compare(a, b));
  return Buffer.concat([cborHead(5, entries.length), ...entries.flat()]);
}

const FLAGS = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

/** The rpId must be the page's host or a parent domain of it, and the page must be secure. */
export function rpIdAllowed(rpId: string, origin: string) {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const secure = url.protocol === "https:" || url.hostname === "localhost";
  const host = url.hostname.toLowerCase();
  const rp = rpId.toLowerCase();
  return (
    secure && rp.includes(".") === host.includes(".") && (host === rp || host.endsWith(`.${rp}`))
  );
}

function clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string) {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
}

export interface CreateInput {
  origin: string;
  rpId: string;
  challenge: string;
  user: { id: string; name: string; displayName?: string };
}

export function createPasskey(input: CreateInput) {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = NodeCrypto.randomBytes(32);
  const coseKey = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, fromB64url(jwk.x!)],
      [-3, fromB64url(jwk.y!)],
    ]),
  );
  const counter = Buffer.alloc(4);
  const credentialIdLength = Buffer.alloc(2);
  credentialIdLength.writeUInt16BE(credentialId.length);
  const authenticatorData = Buffer.concat([
    sha256(input.rpId),
    Buffer.from([FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS | FLAGS.AT]),
    counter,
    Buffer.alloc(16), // AAGUID
    credentialIdLength,
    credentialId,
    coseKey,
  ]);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ["fmt", "none"],
      ["attStmt", new Map()],
      ["authData", authenticatorData],
    ]),
  );
  const record: PasskeyRecord = {
    credentialId: b64url(credentialId),
    rpId: input.rpId,
    userHandle: input.user.id,
    userName: input.user.name,
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
    createdAt: new Date().toISOString(),
  };
  return {
    record,
    response: {
      id: record.credentialId,
      rawId: record.credentialId,
      type: "public-key" as const,
      authenticatorAttachment: "platform" as const,
      response: {
        clientDataJSON: b64url(clientData("webauthn.create", input.challenge, input.origin)),
        attestationObject: b64url(attestationObject),
        authenticatorData: b64url(authenticatorData),
        publicKey: b64url(publicKey.export({ format: "der", type: "spki" })),
        publicKeyAlgorithm: -7,
        transports: ["internal", "hybrid"],
      },
      clientExtensionResults: {},
    },
  };
}

export function assertPasskey(record: PasskeyRecord, input: { origin: string; challenge: string }) {
  const authenticatorData = Buffer.concat([
    sha256(record.rpId),
    Buffer.from([FLAGS.UP | FLAGS.UV | FLAGS.BE | FLAGS.BS]),
    Buffer.alloc(4),
  ]);
  const clientDataJSON = clientData("webauthn.get", input.challenge, input.origin);
  const key = NodeCrypto.createPrivateKey({
    key: Buffer.from(record.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  // WebAuthn ES256 signatures are ASN.1 DER, Node's default.
  const signature = NodeCrypto.sign(
    "sha256",
    Buffer.concat([authenticatorData, sha256(clientDataJSON)]),
    key,
  );
  return {
    id: record.credentialId,
    rawId: record.credentialId,
    type: "public-key" as const,
    authenticatorAttachment: "platform" as const,
    response: {
      clientDataJSON: b64url(clientDataJSON),
      authenticatorData: b64url(authenticatorData),
      signature: b64url(signature),
      userHandle: record.userHandle,
    },
    clientExtensionResults: {},
  };
}
