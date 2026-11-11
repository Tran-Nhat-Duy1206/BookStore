import { defineConfig } from "vitest/config";
import { config } from "dotenv";
import { fileURLToPath } from "node:url";

// This is a mandatory separate Linux acceptance command, never a skipped suite
// or a Windows API-cookie-jar substitute for actual Chromium trust/cookies.
if (process.platform !== "linux")
  throw new Error(
    "HTTPS browser acceptance requires Linux isolated NSS trust.",
  );

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
    include: ["tests/https-transport/browser.test.ts"],
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 240000,
  },
});
