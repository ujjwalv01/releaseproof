import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "action/src/**/*.test.ts",
      ".github/scripts/**/*.test.mjs",
      "website/**/*.test.mjs",
    ],
    setupFiles: ["./packages/core/test/setup.ts"],
  },
});
