import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/env.ts";

const minimal = {
  DATABASE_URL: "postgres://dubbing:pw@localhost:5432/dubbing",
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  REDIS_URL: "redis://localhost:6379",
  INTERNAL_API_TOKEN: "t".repeat(32),
};

describe("environment", () => {
  it("fills in defaults", () => {
    const env = loadEnv(minimal);
    expect(env.PORT).toBe(3000);
    expect(env.TRUSTED_ORIGINS).toEqual([]);
    expect(env.TRUSTED_PROXIES).toEqual([]);
    expect(env.WEB_DIST).toBe("../web/dist");
    expect(env.MIGRATIONS_DIR).toBe("migrations");
    expect(env.JOB_STREAM).toBe("translate:jobs");
    expect(env.JOB_GROUP).toBe("translators");
    expect([env.LEASE_TTL_SEC, env.HEARTBEAT_SEC, env.TRACK_MAX_ATTEMPTS]).toEqual([15, 5, 3]);
  });

  it("checks the translator settings", () => {
    expect(() => loadEnv({ ...minimal, REDIS_URL: "http://localhost:6379" })).toThrow(/REDIS_URL/);
    expect(() => loadEnv({ ...minimal, INTERNAL_API_TOKEN: "short" })).toThrow(/INTERNAL_API_TOKEN/);
    // A worker must be able to miss a heartbeat and keep its track.
    expect(() => loadEnv({ ...minimal, LEASE_TTL_SEC: "10", HEARTBEAT_SEC: "5" })).toThrow(/HEARTBEAT_SEC/);
    expect(loadEnv({ ...minimal, LEASE_TTL_SEC: "30", HEARTBEAT_SEC: "10" }).LEASE_TTL_SEC).toBe(30);
  });

  it("splits comma lists", () => {
    const env = loadEnv({ ...minimal, TRUSTED_ORIGINS: "http://localhost:5173, https://a.example", TRUSTED_PROXIES: "10.0.0.0/8,::1" });
    expect(env.TRUSTED_ORIGINS).toEqual(["http://localhost:5173", "https://a.example"]);
    expect(env.TRUSTED_PROXIES).toEqual(["10.0.0.0/8", "::1"]);
  });

  it("keeps only the origin of each trusted origin, as browsers send it", () => {
    const env = loadEnv({ ...minimal, TRUSTED_ORIGINS: "http://127.0.0.1:3000/, https://a.example/app" });
    expect(env.TRUSTED_ORIGINS).toEqual(["http://127.0.0.1:3000", "https://a.example"]);
  });

  it("names every missing or bad setting", () => {
    expect(() => loadEnv({ BETTER_AUTH_SECRET: "short", PORT: "http" })).toThrow(
      /DATABASE_URL[\s\S]*BETTER_AUTH_SECRET[\s\S]*BETTER_AUTH_URL|PORT/,
    );
    expect(() => loadEnv({ ...minimal, DATABASE_URL: "mysql://x@y/z" })).toThrow(/postgres:\/\//);
    expect(() => loadEnv({ ...minimal, TRUSTED_PROXIES: "not-an-ip" })).toThrow(/TRUSTED_PROXIES/);
  });
});
