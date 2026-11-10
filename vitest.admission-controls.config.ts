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
    include: ["tests/admission-controls/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 180000,
  },
});
