import type { CatalogReadRepository } from "./contracts";
import { FixtureCatalogRepository } from "./fixture-repository";

export function resolveDataSource(
  env: Record<string, string | undefined> = process.env,
): "fixture" | "database" {
  const source = env.DATA_SOURCE;
  if (source === undefined) return "fixture";
  if (source === "fixture" || source === "database") return source;
  throw new Error("DATA_SOURCE must be exactly fixture or database.");
}

export async function createCatalogRepository({
  env = process.env,
  databaseFactory,
}: {
  env?: Record<string, string | undefined>;
  databaseFactory?: (
    databaseUrl: string,
  ) => CatalogReadRepository | Promise<CatalogReadRepository>;
} = {}): Promise<CatalogReadRepository> {
  if (resolveDataSource(env) === "fixture") {
    return new FixtureCatalogRepository();
  }

  const databaseUrl = env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
    throw new Error("DATABASE_URL is required in database mode.");
  }
  if (databaseFactory === undefined) {
    throw new Error("A databaseFactory is required in database mode.");
  }
  return databaseFactory(databaseUrl);
}
