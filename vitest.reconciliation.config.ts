import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

config({
  path: ".env.security-foundation.local",
  quiet: true,
  override: false,
});

export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(
        new URL("./tests/security-foundation/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests/next-security/reconciliation.test.ts"],
    fileParallelism: false,
    testTimeout: 45_000,
    hookTimeout: 180_000,
  },
});
