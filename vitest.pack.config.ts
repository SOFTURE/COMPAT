import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/pack/**/*.test.ts"], testTimeout: 60_000 },
});
