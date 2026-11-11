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
    include: [
      "tests/https-transport/transport.test.ts",
      "tests/https-transport/policy.test.ts",
      "tests/https-transport/tls-feasibility.test.ts",
      "tests/https-transport/upgrade.test.ts",
    ],
    fileParallelism: false,
    testTimeout: 90000,
    hookTimeout: 180000,
  },
});
