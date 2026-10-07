import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // The pack test needs a build first; `npm run test:pack` runs it.
    exclude: ["test/pack/**", "node_modules/**"],
    testTimeout: 60_000,
  },
});
