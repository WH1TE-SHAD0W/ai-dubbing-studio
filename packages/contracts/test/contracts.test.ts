import { describe, expect, it } from "vitest";
import {
  createSessionRequestSchema,
  joinCodeSchema,
  passwordSchema,
  registerRequestSchema,
  startDubbingSessionRequestSchema,
} from "../src/index.ts";

const validSession = {
  title: "Keynote",
  sourceLang: "en",
  targetLangs: ["sk", "de"],
  provider: "gemini",
  consent: { speaker: true, aiNotice: true },
} as const;

describe("join code", () => {
  it("normalises case and whitespace", () => {
    expect(joinCodeSchema.parse(" ab12cd ")).toBe("AB12CD");
  });

  it("rejects the wrong length or characters", () => {
    expect(joinCodeSchema.safeParse("ABC").success).toBe(false);
    expect(joinCodeSchema.safeParse("AB-12C").success).toBe(false);
  });
});

describe("password", () => {
  it("accepts 12 to 128 characters, spaces included", () => {
    expect(passwordSchema.safeParse("correct horse").success).toBe(true);
    expect(passwordSchema.safeParse("x".repeat(128)).success).toBe(true);
  });

  it("rejects passwords that are too short or too long", () => {
    expect(passwordSchema.safeParse("short").success).toBe(false);
    expect(passwordSchema.safeParse("x".repeat(129)).success).toBe(false);
  });

  it("lower-cases the email on register", () => {
    const parsed = registerRequestSchema.parse({ name: "Ana", email: " Ana@Example.COM ", password: "long enough pw" });
    expect(parsed.email).toBe("ana@example.com");
  });
});

describe("create session", () => {
  it("accepts a valid request", () => {
    expect(createSessionRequestSchema.safeParse(validSession).success).toBe(true);
  });

  it("requires both consents", () => {
    const r = createSessionRequestSchema.safeParse({ ...validSession, consent: { speaker: true, aiNotice: false } });
    expect(r.success).toBe(false);
  });

  it("rejects a target that is the spoken language", () => {
    const r = createSessionRequestSchema.safeParse({ ...validSession, targetLangs: ["en"] });
    expect(r.success).toBe(false);
  });

  it("rejects duplicates and more than five targets", () => {
    expect(createSessionRequestSchema.safeParse({ ...validSession, targetLangs: ["sk", "sk"] }).success).toBe(false);
    expect(
      createSessionRequestSchema.safeParse({ ...validSession, targetLangs: ["sk", "de", "fr", "es", "it", "pl"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown provider or language", () => {
    expect(createSessionRequestSchema.safeParse({ ...validSession, provider: "openai" }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({ ...validSession, targetLangs: ["ga"] }).success).toBe(false);
  });
});

describe("dubbing container contract", () => {
  it("matches the ADR-0009 payload", () => {
    const r = startDubbingSessionRequestSchema.safeParse({
      sessionId: "abc",
      languages: { source: "de", destinations: ["en", "sk"] },
      provider: "gemini",
    });
    expect(r.success).toBe(true);
  });
});
