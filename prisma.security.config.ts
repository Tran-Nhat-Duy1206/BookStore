import { defineConfig } from "prisma/config";
import { assertFoundationUrl } from "./src/server/security/database-config";

// No dotenv/legacy credential fallback. Only the separate offline process receives this value.
export default defineConfig({
  schema: "prisma/security.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.SECURITY_MIGRATION_DATABASE_URL
      ? assertFoundationUrl(
          process.env.SECURITY_MIGRATION_DATABASE_URL,
          "migrate",
        )
      : "postgresql://unused:unused@127.0.0.1:1/bookstore_security_codegen",
  },
});
