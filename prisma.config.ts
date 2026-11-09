import { defineConfig } from "prisma/config";
import { config } from "dotenv";
import { assertDatabaseUrl } from "./src/server/database/config";

config({ path: ".env.local", quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations", seed: "tsx prisma/seed.ts" },
  // Code generation is database-independent. Write scripts reject missing URLs
  // before invoking Prisma; this non-listening placeholder is never a runtime fallback.
  datasource: {
    url: process.env.DATABASE_URL
      ? assertDatabaseUrl(process.env.DATABASE_URL)
      : "postgresql://unused:unused@127.0.0.1:1/bookstore_catalog_codegen",
  },
});
