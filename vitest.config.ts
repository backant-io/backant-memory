import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Scope tests to the canonical `tests/` directory.
    include: ["tests/**/*.test.ts", "tests/**/*.spec.ts"],
  },
});
