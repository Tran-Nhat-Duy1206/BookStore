import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const config: NextConfig = {
  distDir: ".next",
  poweredByHeader: false,
  cacheComponents: false,
  partialPrefetching: false,
  turbopack: { root: fileURLToPath(new URL("../../", import.meta.url)) },
  serverExternalPackages: [
    "better-auth",
    "@better-auth/prisma-adapter",
    "@prisma/client",
    "@prisma/adapter-pg",
    "pg",
  ],
  experimental: { serverActions: { bodySizeLimit: 8192 } },
};
export default config;
