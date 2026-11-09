import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolConfig } from "pg";
import { PrismaClient } from "../../generated/prisma/client";
import { assertDatabaseUrl } from "./config";

/** Explicit factory shared by server, CLI and isolated tests. No import-time I/O. */
export function createCatalogClient(
  url: string,
  options: { readOnly?: boolean } = {},
): PrismaClient {
  assertDatabaseUrl(url);
  const poolConfig: PoolConfig = {
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 5000,
    statement_timeout: 10000,
    ...(options.readOnly
      ? { options: "-c default_transaction_read_only=on" }
      : {}),
  };
  return new PrismaClient({ adapter: new PrismaPg(poolConfig) });
}
