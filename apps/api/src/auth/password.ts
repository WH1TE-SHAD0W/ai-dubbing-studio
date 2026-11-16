import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

// Argon2id password hashing for Better Auth (ADR-0003), from node:crypto (Node 24.7+),
// so there is nothing to install. m=64 MiB, t=3, p=4 is the RFC 9106 setting
// (~370 ms on the development laptop).
//
// Stored as one string with its settings, `argon2id$m$t$p$salt$hash` (salt and
// hash in base64url), so the setting can change later and old hashes still verify.

export type Argon2Settings = { memoryKiB: number; passes: number; parallelism: number };

export const DEFAULT_SETTINGS: Argon2Settings = { memoryKiB: 64 * 1024, passes: 3, parallelism: 4 };

const SALT_BYTES = 16;
const HASH_BYTES = 32;

function derive(password: string, salt: Buffer, s: Argon2Settings, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2(
      "argon2id",
      { message: password, nonce: salt, memory: s.memoryKiB, passes: s.passes, parallelism: s.parallelism, tagLength },
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

export async function hashPassword(password: string, settings: Argon2Settings = DEFAULT_SETTINGS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, settings, HASH_BYTES);
  const { memoryKiB, passes, parallelism } = settings;
  return ["argon2id", memoryKiB, passes, parallelism, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  const parts = hash.split("$");
  if (parts.length !== 6 || parts[0] !== "argon2id") return false;
  const [memoryKiB, passes, parallelism] = parts.slice(1, 4).map(Number);
  if (!Number.isSafeInteger(memoryKiB) || !Number.isSafeInteger(passes) || !Number.isSafeInteger(parallelism)) return false;
  const salt = Buffer.from(parts[4] ?? "", "base64url");
  const expected = Buffer.from(parts[5] ?? "", "base64url");
  if (salt.length < 8 || expected.length < 4) return false;
  const actual = await derive(password, salt, { memoryKiB: memoryKiB!, passes: passes!, parallelism: parallelism! }, expected.length);
  return timingSafeEqual(actual, expected);
}
