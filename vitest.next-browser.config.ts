import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { resolve } from "node:path";
if (process.platform !== "linux")
  throw new Error(
    "Next browser acceptance requires actual Linux isolated NSS trust.",
  );
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
    include: ["tests/next-security/browser.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90000,
    hookTimeout: 240000,
  },
});
