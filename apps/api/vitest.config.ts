import { defineConfig } from "vitest/config";

// The database tests share one Postgres, and the track sweeper works on the
// whole table, so the test files run one after another.
export default defineConfig({
  test: { fileParallelism: false },
});
