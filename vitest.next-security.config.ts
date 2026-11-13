import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import { config } from "dotenv";
config({
  path: ".env.security-foundation.local",
  quiet: true,
  override: false,
});
export default defineConfig({
  resolve: {
    alias: {
      "server-only": resolve("tests/security-foundation/server-only.ts"),
    },
  },
  test: {
    include: [
      "tests/next-security/smoke.test.ts",
      "tests/next-security/transport.test.ts",
      "tests/next-security/lifecycle.test.ts",
      "tests/next-security/commit-abort.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90000,
    hookTimeout: 180000,
    env: { NODE_ENV: "test" },
  },
});
