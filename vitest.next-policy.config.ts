import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/** Pure wire mechanics only: no provider, database, credentials or TLS fixture. */
export default defineConfig({
  resolve: {
    alias: {
      "server-only": resolve("tests/security-foundation/server-only.ts"),
    },
  },
  test: {
    include: [
      "tests/next-security/wire-policy.test.ts",
      "tests/next-security/cookie-projection.test.ts",
      "tests/next-security/outgoing-observer.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
