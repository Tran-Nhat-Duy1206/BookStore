/** Batch 3.1 is deliberately limited to isolated loopback BookStore databases. */
export function assertDatabaseUrl(value: string): string {
  if (value !== value.trim())
    throw new Error("Invalid BookStore database URL.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid BookStore database URL.");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["55432", "55433"].includes(url.port) ||
    decodeURIComponent(url.username) !== "bookstore_catalog" ||
    !url.password ||
    !/^\/bookstore_catalog_(dev|test|ci|replay|upgrade)(_[a-f0-9]{12})?$/.test(
      url.pathname,
    ) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Database access is restricted to the isolated loopback BookStore Batch 3.1 instance (ports 55432/55433).",
    );
  }
  return value;
}
export function getDatabaseUrl(
  env: Record<string, string | undefined> = process.env,
): string {
  if (!env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required for explicit database operations.",
    );
  return assertDatabaseUrl(env.DATABASE_URL);
}
export function assertLocalReadMode(
  env: Record<string, string | undefined> = process.env,
) {
  if (env.NODE_ENV === "production" && env.BOOKSTORE_LOCAL_DB_READS !== "1") {
    throw new Error(
      "Database mode is local/CI opt-in only. For a loopback production-build smoke test, explicitly set BOOKSTORE_LOCAL_DB_READS=1.",
    );
  }
}
