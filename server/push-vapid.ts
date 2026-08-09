import type Database from "better-sqlite3";
import { generateKeyPairSync } from "node:crypto";
import { base64Url, type VapidKeys } from "./push-crypto.ts";

interface VapidRow {
  public_key: string;
  private_key: string;
}

export function loadOrCreateVapidKeys(db: Database.Database): VapidKeys {
  const existing = db
    .prepare("SELECT public_key, private_key FROM push_vapid WHERE id = 1")
    .get() as VapidRow | undefined;
  if (existing) {
    return {
      publicKey: existing.public_key,
      privateKey: existing.private_key,
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" }) as {
    x?: string;
    y?: string;
  };
  if (!jwk.x || !jwk.y) throw new Error("Generated VAPID key is missing coordinates");

  const keys = {
    publicKey: base64Url(
      Buffer.concat([
        Buffer.from([0x04]),
        Buffer.from(jwk.x, "base64url"),
        Buffer.from(jwk.y, "base64url"),
      ]),
    ),
    privateKey: base64Url(
      privateKey.export({ format: "der", type: "pkcs8" }) as Buffer,
    ),
  };
  db.prepare(
    "INSERT INTO push_vapid (id, public_key, private_key) VALUES (1, ?, ?)",
  ).run(keys.publicKey, keys.privateKey);
  return keys;
}
