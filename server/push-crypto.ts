import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  randomBytes,
  sign,
} from "node:crypto";

const WEB_PUSH_INFO = Buffer.from("WebPush: info", "ascii");
const AES128GCM_INFO = Buffer.from("Content-Encoding: aes128gcm\0", "ascii");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0", "ascii");
const RECORD_SIZE = 4096;
const P256_PUBLIC_KEY_BYTES = 65;
const P256_PRIVATE_KEY_BYTES = 32;

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface EncryptPayloadInput {
  payload: Buffer;
  p256dh: string;
  auth: string;
  salt?: Buffer;
  ephemeralPrivateKey?: Buffer;
}

export function base64Url(input: Buffer | string): string {
  return Buffer.isBuffer(input)
    ? input.toString("base64url")
    : Buffer.from(input).toString("base64url");
}

export function signVapidJwt({
  audience,
  subject,
  privateKey,
  expSeconds,
  nowSeconds = Math.floor(Date.now() / 1000),
}: {
  audience: string;
  subject: string;
  privateKey: string;
  expSeconds: number;
  nowSeconds?: number;
}): string {
  if (expSeconds <= 0 || expSeconds > 12 * 60 * 60) {
    throw new Error("VAPID expSeconds must be greater than 0 and at most 12 hours");
  }

  const header = base64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = base64Url(
    JSON.stringify({
      aud: audience,
      exp: nowSeconds + expSeconds,
      sub: subject,
    }),
  );
  const signingInput = `${header}.${payload}`;
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const derSignature = sign("sha256", Buffer.from(signingInput), key);
  return `${signingInput}.${base64Url(derToJose(derSignature))}`;
}

export function buildVapidAuthHeader(jwt: string, vapidPublicKey: string): string {
  return `vapid t=${jwt}, k=${vapidPublicKey}`;
}

export function encryptPayload({
  payload,
  p256dh,
  auth,
  salt = randomBytes(16),
  ephemeralPrivateKey,
}: EncryptPayloadInput): Buffer {
  if (salt.length !== 16) throw new Error("Web Push salt must be 16 bytes");

  const uaPublic = Buffer.from(p256dh, "base64url");
  const authSecret = Buffer.from(auth, "base64url");
  if (uaPublic.length !== P256_PUBLIC_KEY_BYTES || uaPublic[0] !== 0x04) {
    throw new Error("Web Push p256dh key must be an uncompressed P-256 point");
  }

  const server = createECDH("prime256v1");
  if (ephemeralPrivateKey) {
    if (ephemeralPrivateKey.length !== P256_PRIVATE_KEY_BYTES) {
      throw new Error("Web Push ephemeral private key must be 32 bytes");
    }
    server.setPrivateKey(ephemeralPrivateKey);
  } else {
    server.generateKeys();
  }

  const asPublic = server.getPublicKey();
  const ecdhSecret = server.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([
    WEB_PUSH_INFO,
    Buffer.from([0]),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const prk = hkdfExtract(salt, ikm);
  const cek = hkdfExpand(prk, AES128GCM_INFO, 16);
  const nonce = hkdfExpand(prk, NONCE_INFO, 12);
  const plaintext = Buffer.concat([payload, Buffer.from([0x02])]);

  const cipher = createCipheriv("aes-128-gcm", cek, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(16 + 4 + 1 + P256_PUBLIC_KEY_BYTES);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(P256_PUBLIC_KEY_BYTES, 20);
  asPublic.copy(header, 21);
  return Buffer.concat([header, ciphertext]);
}

export function derToJose(der: Buffer): Buffer {
  let offset = 0;
  if (der[offset] !== 0x30) throw new Error("Invalid ECDSA DER signature");
  offset += 1;
  const sequenceLength = readDerLength(der, offset);
  offset = sequenceLength.nextOffset;
  if (sequenceLength.length !== der.length - offset) {
    throw new Error("Invalid ECDSA DER sequence length");
  }
  const r = readDerInteger(der, offset);
  offset = r.nextOffset;
  const s = readDerInteger(der, offset);
  if (s.nextOffset !== der.length) throw new Error("Invalid ECDSA DER trailing data");
  return Buffer.concat([normalizeJoseInteger(r.value), normalizeJoseInteger(s.value)]);
}

export function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return createHmac("sha256", salt).update(ikm).digest();
}

export function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  const chunks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let counter = 1;
  while (Buffer.concat(chunks).length < length) {
    previous = createHmac("sha256", prk)
      .update(Buffer.concat([previous, info, Buffer.from([counter])]))
      .digest();
    chunks.push(previous);
    counter += 1;
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  return hkdfExpand(hkdfExtract(salt, ikm), info, length);
}

function readDerInteger(
  der: Buffer,
  offset: number,
): { value: Buffer; nextOffset: number } {
  if (der[offset] !== 0x02) throw new Error("Invalid ECDSA DER integer");
  const length = readDerLength(der, offset + 1);
  const start = length.nextOffset;
  const end = start + length.length;
  if (end > der.length) throw new Error("Invalid ECDSA DER integer length");
  return { value: der.subarray(start, end), nextOffset: end };
}

function readDerLength(
  der: Buffer,
  offset: number,
): { length: number; nextOffset: number } {
  const first = der[offset];
  if (first === undefined) throw new Error("Invalid ECDSA DER length");
  if (first < 0x80) return { length: first, nextOffset: offset + 1 };
  const byteCount = first & 0x7f;
  if (byteCount === 0 || byteCount > 2) throw new Error("Unsupported DER length");
  let length = 0;
  for (let i = 0; i < byteCount; i += 1) {
    const byte = der[offset + 1 + i];
    if (byte === undefined) throw new Error("Invalid ECDSA DER length bytes");
    length = (length << 8) | byte;
  }
  return { length, nextOffset: offset + 1 + byteCount };
}

function normalizeJoseInteger(value: Buffer): Buffer {
  let trimmed = value;
  while (trimmed.length > 0 && trimmed[0] === 0) {
    trimmed = trimmed.subarray(1);
  }
  if (trimmed.length > P256_PRIVATE_KEY_BYTES) {
    throw new Error("ECDSA DER integer is too large for P-256");
  }
  return Buffer.concat([Buffer.alloc(P256_PRIVATE_KEY_BYTES - trimmed.length), trimmed]);
}
