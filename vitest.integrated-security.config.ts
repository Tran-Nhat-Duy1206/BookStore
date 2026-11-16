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
      "tests/integrated-security/kernel-continuity.test.ts",
      "tests/integrated-security/kernel-decision-fault.test.ts",
      "tests/integrated-security/native-denial-audit.test.ts",
      "tests/integrated-security/post-native-recheck.test.ts",
      "tests/integrated-security/next-composition.test.ts",
      "tests/integrated-security/continuity-upgrade.test.ts",
      "tests/integrated-security/cross-transport-replay.test.ts",
      "tests/integrated-security/startup-ownership.test.ts",
      "tests/integrated-security/clock-quality-investigation.test.ts",
      "tests/integrated-security/clock-latency-attribution.test.ts",
      "tests/integrated-security/clock-startup-concurrency.test.ts",
    ],
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 90000,
    hookTimeout: 180000,
    env: { NODE_ENV: "test" },
  },
});
