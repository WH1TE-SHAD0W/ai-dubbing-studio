import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { z } from "zod";

// Checks a request part against a contract schema (ADR-0016). A failure answers
// 400 with the first problem in the shape every API error has: `{ message }`.
export function validate<T extends keyof ValidationTargets, S extends z.ZodType>(target: T, schema: S) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      return c.json({ message: result.error.issues[0]?.message ?? "Invalid request." }, 400);
    }
  });
}
