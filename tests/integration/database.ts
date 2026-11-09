import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { assertDatabaseUrl } from "../../src/server/database/config";

const created = new Map<string, string>();

function quoteOwnedName(name: string): string {
  if (!/^bookstore_catalog_test_[a-f0-9]{12}$/.test(name)) {
    throw new Error("Refusing non-disposable database identifier.");
  }
  return `"${name}"`;
}

/** The base database is an administration connection only; never migrated/reset. */
export async function createDisposableDatabase() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    throw new Error("TEST_DATABASE_URL is required for integration tests.");
  assertDatabaseUrl(base);
  const baseUrl = new URL(base);
  if (!/^\/bookstore_catalog_(test|ci)$/.test(baseUrl.pathname)) {
    throw new Error(
      "Integration administration requires the exact test or ci database.",
    );
  }
  const suffix = randomBytes(6).toString("hex");
  const name = `bookstore_catalog_test_${suffix}`;
  const marker = `bookstore-catalog-integration:${suffix}`;
  const identifier = quoteOwnedName(name);
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${identifier}`);
    // Both name and marker consist only of fixed text and locally generated hex.
    created.set(name, marker);
    await admin.query(`COMMENT ON DATABASE ${identifier} IS '${marker}'`);
  } finally {
    await admin.end();
  }
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  assertDatabaseUrl(url.toString());
  return {
    url: url.toString(),
    async dispose() {
      if (created.get(name) !== marker) {
        throw new Error("Refusing to drop a database not created by this run.");
      }
      const cleanup = new Client({ connectionString: base });
      await cleanup.connect();
      try {
        const result = await cleanup.query<{ marker: string | null }>(
          "SELECT shobj_description(oid, 'pg_database') AS marker FROM pg_database WHERE datname = $1",
          [name],
        );
        if (result.rows.length !== 1 || result.rows[0].marker !== marker) {
          throw new Error(
            "Disposable database ownership marker does not match; refusing drop.",
          );
        }
        // No FORCE: leaked clients are a test failure, never terminated implicitly.
        await cleanup.query(`DROP DATABASE ${quoteOwnedName(name)}`);
        created.delete(name);
      } finally {
        await cleanup.end();
      }
    },
  };
}
