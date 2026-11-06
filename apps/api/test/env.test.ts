import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.ts";

const minimal = {
  DATABASE_URL: "postgres://dubbing:pw@localhost:5432/dubbing",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("environment", () => {
  it("fills in defaults", () => {
    const env = loadEnv(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.TRUSTED_ORIGINS).toEqual([]);
    expect(env.TRUSTED_PROXIES).toEqual([]);
    expect(env.WEB_DIST).toBe("../web/dist");
  });

  it("splits comma lists", () => {
    const env = loadEnv({ ...minimal, TRUSTED_ORIGINS: "http://localhost:5173, https://a.example", TRUSTED_PROXIES: "10.0.0.0/8,::1" });
    expect(env.TRUSTED_ORIGINS).toEqual(["http://localhost:5173", "https://a.example"]);
    expect(env.TRUSTED_PROXIES).toEqual(["10.0.0.0/8", "::1"]);
  });

  it("names every missing or bad setting", () => {
    expect(() => loadEnv({ BETTER_AUTH_SECRET: "short", PORT: "http" })).toThrow(
      /DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*BETTER_AUTH_URL|PORT/,
    );
    expect(() => loadEnv({ ...minimal, DATABASE_URL: "mysql://x@y/z" })).toThrow(/postgres:\/\//);
    expect(() => loadEnv({ ...minimal, TRUSTED_PROXIES: "not-an-ip" })).toThrow(/TRUSTED_PROXIES/);
  });
});
