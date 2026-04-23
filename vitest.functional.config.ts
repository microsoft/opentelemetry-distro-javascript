import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/internal/functional/**/*.test.ts"],
    exclude: ["test/**/snippets.spec.ts"],
    reporters: ["default"],
    testTimeout: 30000,
  },
});
