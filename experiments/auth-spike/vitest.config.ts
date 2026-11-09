import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Unlike the application, only a separate experimental environment is read.
config({ path: ".env.auth-spike.local", quiet: true });
export default defineConfig({
  test: {
    include: ["experiments/auth-spike/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 120000,
  },
});
