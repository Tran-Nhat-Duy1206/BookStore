import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/https-transport/tls-feasibility.test.ts"],
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 180000,
  },
});
