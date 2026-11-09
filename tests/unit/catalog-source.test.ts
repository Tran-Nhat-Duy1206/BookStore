import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CatalogReadRepository,
  CatalogSnapshot,
} from "@/modules/catalog/contracts";
import { books, categories, series } from "@/modules/catalog/data";
import {
  createCatalogRepository,
  resolveDataSource,
} from "@/modules/catalog/data-source";
import { FixtureCatalogRepository } from "@/modules/catalog/fixture-repository";
import { discoverBooks } from "@/modules/catalog/search";

const sourceSnapshot: CatalogSnapshot = { books, series, categories };

// These are deliberately inert test values, not connection credentials.
const databaseUrl = "postgresql://127.0.0.1:65432/bookstore_test";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("catalog source selection", () => {
  it("defaults only an unset DATA_SOURCE to fixture", () => {
    expect(resolveDataSource({})).toBe("fixture");
    expect(resolveDataSource({ DATA_SOURCE: undefined })).toBe("fixture");
  });

  it.each(["fixture", "database"] as const)(
    "accepts the exact %s mode",
    (mode) => {
      expect(resolveDataSource({ DATA_SOURCE: mode })).toBe(mode);
    },
  );

  it.each([
    "",
    " ",
    "\t\n",
    " fixture",
    "fixture ",
    " database ",
    "FIXTURE",
    "Database",
    "postgres",
    "undefined",
  ])("rejects the explicit invalid mode %j", async (mode) => {
    const env = { DATA_SOURCE: mode, DATABASE_URL: databaseUrl };
    const databaseFactory = vi.fn();
    expect(() => resolveDataSource(env)).toThrow(/DATA_SOURCE/);
    await expect(
      createCatalogRepository({ env, databaseFactory }),
    ).rejects.toThrow(/DATA_SOURCE/);
    expect(databaseFactory).not.toHaveBeenCalled();
  });

  it("uses process.env defaults without requiring a database URL or factory", async () => {
    vi.stubEnv("DATA_SOURCE", undefined);
    vi.stubEnv("DATABASE_URL", undefined);
    expect(resolveDataSource()).toBe("fixture");
    const repository = await createCatalogRepository();
    expect(repository).toBeInstanceOf(FixtureCatalogRepository);
    expect(await repository.getSnapshot()).toStrictEqual(sourceSnapshot);
  });

  it.each([undefined, "fixture"])(
    "does not call a database factory in fixture mode %j, even with a URL",
    async (mode) => {
      const databaseFactory = vi.fn(() => {
        throw new Error("Database factory must not run in fixture mode");
      });
      const repository = await createCatalogRepository({
        env: { DATA_SOURCE: mode, DATABASE_URL: databaseUrl },
        databaseFactory,
      });
      expect(repository).toBeInstanceOf(FixtureCatalogRepository);
      expect(await repository.getSnapshot()).toStrictEqual(sourceSnapshot);
      expect(databaseFactory).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", " ", "\t\n"])(
    "requires a nonblank DATABASE_URL in database mode: %j",
    async (url) => {
      const databaseFactory = vi.fn();
      await expect(
        createCatalogRepository({
          env: { DATA_SOURCE: "database", DATABASE_URL: url },
          databaseFactory,
        }),
      ).rejects.toThrow(/DATABASE_URL/);
      expect(databaseFactory).not.toHaveBeenCalled();
    },
  );

  it("requires an explicit database factory rather than falling back to fixtures", async () => {
    await expect(
      createCatalogRepository({
        env: { DATA_SOURCE: "database", DATABASE_URL: databaseUrl },
      }),
    ).rejects.toThrow(/databaseFactory/);
  });

  it.each([false, true])(
    "returns the supplied repository unchanged (async factory: %s)",
    async (asyncFactory) => {
      const repository: CatalogReadRepository = {
        getSnapshot: vi.fn(async () => structuredClone(sourceSnapshot)),
      };
      const originalUrl = ` ${databaseUrl} `;
      const databaseFactory = vi.fn(() =>
        asyncFactory ? Promise.resolve(repository) : repository,
      );
      const result = await createCatalogRepository({
        env: { DATA_SOURCE: "database", DATABASE_URL: originalUrl },
        databaseFactory,
      });
      expect(result).toBe(repository);
      expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(originalUrl);
      expect(repository.getSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "propagates the exact factory failure without fallback (async: %s)",
    async (asyncFailure) => {
      const sentinel = new Error("configuration or connection failure");
      const databaseFactory = vi.fn(() => {
        if (asyncFailure) return Promise.reject(sentinel);
        throw sentinel;
      });
      await expect(
        createCatalogRepository({
          env: { DATA_SOURCE: "database", DATABASE_URL: databaseUrl },
          databaseFactory,
        }),
      ).rejects.toBe(sentinel);
      expect(databaseFactory).toHaveBeenCalledExactlyOnceWith(databaseUrl);
    },
  );

  it("propagates the exact snapshot failure without catching or substituting data", async () => {
    const sentinel = new Error("snapshot read failed");
    const repository: CatalogReadRepository = {
      getSnapshot: vi.fn(async () => {
        throw sentinel;
      }),
    };
    const result = await createCatalogRepository({
      env: { DATA_SOURCE: "database", DATABASE_URL: databaseUrl },
      databaseFactory: () => repository,
    });
    await expect(result.getSnapshot()).rejects.toBe(sentinel);
  });
});

describe("fixture catalog read boundary", () => {
  it("preserves the complete public snapshot, curated order, IDs and slugs", async () => {
    const snapshot = await new FixtureCatalogRepository().getSnapshot();
    expect(snapshot).toStrictEqual(sourceSnapshot);
    expect(snapshot.books.map(({ id, slug }) => ({ id, slug }))).toEqual(
      books.map(({ id, slug }) => ({ id, slug })),
    );
    expect(
      snapshot.series.map(({ id, slug, bookIds }) => ({ id, slug, bookIds })),
    ).toEqual(series.map(({ id, slug, bookIds }) => ({ id, slug, bookIds })));
    expect(snapshot.categories.map(({ id }) => id)).toEqual(
      categories.map(({ id }) => id),
    );
  });

  it("deep-copies every read, including nested series book IDs, across instances", async () => {
    const expected = structuredClone(sourceSnapshot);
    const repository = new FixtureCatalogRepository();
    const first = await repository.getSnapshot();
    const second = await repository.getSnapshot();

    expect(first).not.toBe(second);
    for (const key of ["books", "series", "categories"] as const) {
      expect(first[key]).not.toBe(sourceSnapshot[key]);
      expect(first[key]).not.toBe(second[key]);
      expect(first[key][0]).not.toBe(sourceSnapshot[key][0]);
      expect(first[key][0]).not.toBe(second[key][0]);
    }
    expect(first.series[0].bookIds).not.toBe(series[0].bookIds);
    expect(first.series[0].bookIds).not.toBe(second.series[0].bookIds);

    first.books[0].id = "mutated-id";
    first.books[0].slug = "mutated-slug";
    first.books.reverse();
    first.books.pop();
    first.series[0].title = "mutated-series";
    first.series[0].bookIds.splice(0, 1, "mutated-book-id");
    first.series.reverse();
    first.categories[0].label = "mutated-category";
    first.categories.pop();

    expect(sourceSnapshot).toStrictEqual(expected);
    expect(second).toStrictEqual(expected);
    expect(await repository.getSnapshot()).toStrictEqual(expected);
    expect(await new FixtureCatalogRepository().getSnapshot()).toStrictEqual(
      expected,
    );
  });

  it("retains existing Vietnamese search, filter and ordering behavior", async () => {
    const snapshot = await new FixtureCatalogRepository().getSnapshot();
    for (const query of [
      "",
      "ĐÊM TRĂNG",
      "do may",
      "MÂY trăng ĐỖ mái",
      "xyz",
    ]) {
      for (const category of [undefined, "all", " manga ", "not-a-category"]) {
        for (const sort of [undefined, "title", "recent", "unsupported"]) {
          const options = { query, category, sort };
          expect(discoverBooks(snapshot.books, options)).toStrictEqual(
            discoverBooks(books, options),
          );
        }
      }
    }
    expect(snapshot).toStrictEqual(sourceSnapshot);
  });
});
