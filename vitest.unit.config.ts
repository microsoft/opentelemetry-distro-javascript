import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/internal/unit/**/*.test.ts"],
    exclude: ["test/**/snippets.spec.ts"],
    reporters: ["default"],
    testTimeout: 30000,
  },
});
