import { describe, expect, it } from "vitest";
import { isCommonPassword } from "../src/auth/common-passwords.ts";
import { DEFAULT_SETTINGS, hashPassword, verifyPassword } from "../src/auth/password.ts";

describe("argon2id password hashing", () => {
  it("stores the ADR-0003 settings with the hash", async () => {
    const hash = await hashPassword("correct horse battery");
    const [algo, m, t, p, salt, digest] = hash.split("$");
    expect([algo, m, t, p]).toEqual(["argon2id", "65536", "3", "4"]);
    expect(Buffer.from(salt!, "base64url")).toHaveLength(16);
    expect(Buffer.from(digest!, "base64url")).toHaveLength(32);
  });

  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct horse battery");
    expect(await verifyPassword({ hash, password: "correct horse battery" })).toBe(true);
    expect(await verifyPassword({ hash, password: "correct horse battery!" })).toBe(false);
  });

  it("uses a new salt every time", async () => {
    expect(await hashPassword("same password here")).not.toBe(await hashPassword("same password here"));
  });

  it("still verifies hashes made with older, cheaper settings", async () => {
    const old = await hashPassword("an older password", { memoryKiB: 19 * 1024, passes: 2, parallelism: 1 });
    expect(old.startsWith("argon2id$19456$2$1$")).toBe(true);
    expect(await verifyPassword({ hash: old, password: "an older password" })).toBe(true);
    expect(DEFAULT_SETTINGS.memoryKiB).toBe(65536);
  });

  it("rejects malformed or foreign hashes instead of throwing", async () => {
    for (const hash of ["", "argon2id$1$2", "scrypt$a$b$c$d$e", "argon2id$x$3$4$AAAAAAAAAAA$AAAAAAAA"]) {
      expect(await verifyPassword({ hash, password: "anything at all" })).toBe(false);
    }
  });
});

describe("common passwords", () => {
  it("refuses listed passwords, ignoring case and outer spaces", () => {
    expect(isCommonPassword("password1234")).toBe(true);
    expect(isCommonPassword("  PassWord1234 ")).toBe(true);
    expect(isCommonPassword("quiet violet harbour")).toBe(false);
  });
});
