import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts", "./vitest.sidecar-guard.ts"],
    include: ["tests/critical/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 2,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
