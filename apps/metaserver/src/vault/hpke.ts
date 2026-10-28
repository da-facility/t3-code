import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";

/**
 * HPKE base mode, DHKEM(P-256, HKDF-SHA256) + HKDF-SHA256 + AES-256-GCM: the
 * suite CryptoKit calls `P256_SHA256_AES_GCM_256`, so the phone's Secure
 * Enclave key and the metaserver interoperate. Keys and `enc` are uncompressed SEC1
 * points (CryptoKit's x963Representation), base64 on the wire.
 */

export const suite = new CipherSuite({
  kem: new DhkemP256HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Aes256Gcm(),
});

export const INFO_WRAPPED_KEY = new TextEncoder().encode("scope/vault-key/v1");
export const INFO_UNLOCK = new TextEncoder().encode("scope/unlock/v1");

export interface Sealed {
  enc: string;
  ct: string;
}

const b64 = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes as ArrayBuffer).toString("base64");
/** An ArrayBuffer holding exactly these bytes; Node Buffers can be views on a shared pool. */
const exact = (bytes: Uint8Array) => new Uint8Array(bytes).buffer;

const unb64 = (text: string) => {
  const buffer = Buffer.from(text, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

export async function seal(
  recipientPublicKey: string,
  plaintext: Uint8Array,
  info: Uint8Array,
  aad?: Uint8Array,
): Promise<Sealed> {
  const publicKey = await suite.kem.deserializePublicKey(unb64(recipientPublicKey));
  const { ct: ciphertext, enc } = await suite.seal(
    { recipientPublicKey: publicKey, info: exact(info) },
    exact(plaintext),
    aad ? exact(aad) : undefined,
  );
  return { enc: b64(enc), ct: b64(ciphertext) };
}

export async function open(
  recipientKey: CryptoKeyPair,
  sealed: Sealed,
  info: Uint8Array,
  aad?: Uint8Array,
): Promise<Uint8Array> {
  const plaintext = await suite.open(
    { recipientKey, enc: unb64(sealed.enc), info: exact(info) },
    unb64(sealed.ct),
    aad ? exact(aad) : undefined,
  );
  return new Uint8Array(plaintext);
}

export async function generateKeyPair() {
  const keyPair = await suite.kem.generateKeyPair();
  const publicKey = b64(await suite.kem.serializePublicKey(keyPair.publicKey));
  return { keyPair, publicKey };
}
