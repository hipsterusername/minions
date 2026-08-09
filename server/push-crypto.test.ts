import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64Url,
  buildVapidAuthHeader,
  derToJose,
  encryptPayload,
  signVapidJwt,
} from "./push-crypto.ts";

function b64(input: string): Buffer {
  return Buffer.from(input.replace(/\s+/g, ""), "base64url");
}

function decodeJsonPart<T>(jwt: string, part: number): T {
  const value = jwt.split(".")[part];
  if (!value) throw new Error("Missing JWT part");
  return JSON.parse(Buffer.from(value, "base64url").toString()) as T;
}

describe("encryptPayload", () => {
  it("reproduces the RFC 8291 Appendix A aes128gcm example", () => {
    const plaintext = b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
    const receiverPublic = [
      "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx",
      "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
    ].join("");
    const auth = "BTBZMqHH6r4Tts7J_aSIgg";

    const body = encryptPayload({
      payload: plaintext,
      p256dh: receiverPublic,
      auth,
      salt: b64("DGv6ra1nlYgDCS1FRnbzlw"),
      ephemeralPrivateKey: b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    });

    expect(body.toString("base64url")).toBe(
      [
        "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
        "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
        "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
      ].join(""),
    );
  });
});

describe("VAPID JWT helpers", () => {
  it("converts DER ECDSA signatures to JOSE r||s form", () => {
    const r = Buffer.from([
      0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99,
      0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
      0x00, 0xff, 0xee, 0xdd, 0xcc, 0xbb, 0xaa, 0x99,
      0x88, 0x77, 0x66, 0x55, 0x44, 0x33, 0x22, 0x11,
      0x00,
    ]);
    const s = Buffer.from([
      0x00, 0x80, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06,
      0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
      0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16,
      0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e,
      0x1f,
    ]);
    const integers = Buffer.concat([
      Buffer.from([0x02, r.length]),
      r,
      Buffer.from([0x02, s.length]),
      s,
    ]);
    const der = Buffer.concat([Buffer.from([0x30, integers.length]), integers]);

    const jose = derToJose(der);

    expect(jose).toHaveLength(64);
    expect(jose.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xee]));
    expect(jose.subarray(32, 34)).toEqual(Buffer.from([0x80, 0x01]));
  });

  it("signs an ES256 VAPID JWT with the expected claims and raw signature", () => {
    const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateKey = base64Url(
      pair.privateKey.export({ format: "der", type: "pkcs8" }) as Buffer,
    );

    const jwt = signVapidJwt({
      audience: "https://push.example.test",
      subject: "mailto:test@example.test",
      privateKey,
      expSeconds: 60,
      nowSeconds: 100,
    });
    const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
      throw new Error("JWT was not compact serialized");
    }

    expect(decodeJsonPart(jwt, 0)).toEqual({ typ: "JWT", alg: "ES256" });
    expect(decodeJsonPart(jwt, 1)).toEqual({
      aud: "https://push.example.test",
      exp: 160,
      sub: "mailto:test@example.test",
    });
    expect(Buffer.from(encodedSignature, "base64url")).toHaveLength(64);
    expect(
      verify(
        "sha256",
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        { key: createPublicKey(pair.privateKey), dsaEncoding: "ieee-p1363" },
        Buffer.from(encodedSignature, "base64url"),
      ),
    ).toBe(true);
  });

  it("builds the RFC 8292 VAPID Authorization header form", () => {
    expect(buildVapidAuthHeader("jwt", "public")).toBe("vapid t=jwt, k=public");
  });
});
