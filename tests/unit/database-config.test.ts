import { describe, expect, it } from "vitest";
import {
  assertDatabaseUrl,
  assertLocalReadMode,
  getDatabaseUrl,
} from "../../src/server/database/config";

const local =
  "postgresql://bookstore_catalog:unit-test-only@127.0.0.1:55432/bookstore_catalog_dev";
describe("isolated database configuration without connections", () => {
  it("accepts only explicit BookStore loopback development/test URLs", () => {
    expect(assertDatabaseUrl(local)).toBe(local);
    expect(
      assertDatabaseUrl(
        local.replace(
          "55432/bookstore_catalog_dev",
          "55433/bookstore_catalog_ci",
        ),
      ),
    ).toContain("55433");
    expect(
      assertDatabaseUrl(
        local.replace(
          "bookstore_catalog_dev",
          "bookstore_catalog_test_deadbeefdead",
        ),
      ),
    ).toContain("deadbeefdead");
  });
  it.each([
    "",
    "not-a-url",
    " " + local,
    local.replace("postgresql:", "https:"),
    local.replace("127.0.0.1", "database.example.com"),
    local.replace("55432", "5432"),
    local.replace("55432", "5433"),
    local.replace("bookstore_catalog_dev", "another_project"),
    local.replace("bookstore_catalog:", "postgres:"),
    local.replace("unit-test-only", ""),
    local + "?schema=public",
    local + "#fragment",
  ])("refuses unsafe or unrelated database configuration %#", (value) => {
    expect(() => assertDatabaseUrl(value)).toThrow();
  });
  it("requires URL rather than inferring an existing local database", () => {
    expect(() => getDatabaseUrl({})).toThrow("DATABASE_URL");
    expect(getDatabaseUrl({ DATABASE_URL: local })).toBe(local);
  });
  it("blocks production-mode database reads without an explicit local smoke-test opt-in", () => {
    expect(() => assertLocalReadMode({ NODE_ENV: "production" })).toThrow(
      "local/CI",
    );
    expect(() =>
      assertLocalReadMode({
        NODE_ENV: "production",
        BOOKSTORE_LOCAL_DB_READS: "true",
      }),
    ).toThrow();
    expect(() =>
      assertLocalReadMode({
        NODE_ENV: "production",
        BOOKSTORE_LOCAL_DB_READS: "1",
      }),
    ).not.toThrow();
    expect(() =>
      assertLocalReadMode({ NODE_ENV: "development" }),
    ).not.toThrow();
  });
  it("never repeats connection credentials in configuration errors", () => {
    const value = local.replace("127.0.0.1", "other.example.com");
    expect(() => assertDatabaseUrl(value)).toThrow();
    try {
      assertDatabaseUrl(value);
    } catch (error) {
      expect(String(error)).not.toContain("unit-test-only");
    }
  });
});
