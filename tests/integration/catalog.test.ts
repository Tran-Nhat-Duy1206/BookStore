import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runPrisma } from "../../scripts/database";
import { catalogSeedId, seedCatalog } from "../../prisma/seed";
import { books, categories, series } from "../../src/modules/catalog/data";
import { createCatalogRepository } from "../../src/modules/catalog/data-source";
import {
  createPostgresCatalogRepository,
  PostgresCatalogRepository,
} from "../../src/modules/catalog/postgres-repository";
import { discoverBooks } from "../../src/modules/catalog/search";
import { createCatalogClient } from "../../src/server/database/client";
import { createDisposableDatabase } from "./database";

const fixture = { books, series, categories };
const counts = {
  works: 9,
  volumes: 11,
  editions: 12,
  products: 12,
  skus: 12,
  categories: 6,
  series: 2,
};
const first = books[0];
const standalone = books.find((book) => !book.seriesId)!;
const omnibus = books.find((book) => book.id.endsWith("hop-tuyen"))!;
const id = catalogSeedId;
let database: Awaited<ReturnType<typeof createDisposableDatabase>>;
let client: ReturnType<typeof createCatalogClient>;
let sql: Client;
let repository: PostgresCatalogRepository;

async function expectSqlError(query: string, values: unknown[], code: string) {
  await sql.query("BEGIN");
  try {
    await expect(sql.query(query, values)).rejects.toMatchObject({ code });
  } finally {
    await sql.query("ROLLBACK");
  }
}

beforeAll(async () => {
  database = await createDisposableDatabase();
  await runPrisma(["migrate", "deploy"], database.url);
  client = createCatalogClient(database.url);
  sql = new Client({ connectionString: database.url });
  await sql.connect();
  repository = new PostgresCatalogRepository(
    createCatalogClient(database.url, { readOnly: true }),
  );
  expect(await repository.getSnapshot()).toStrictEqual({
    books: [],
    series: [],
    categories: [],
  });
  // Empty replay is distinct from seed replay; neither command targets the base DB.
  await runPrisma(["migrate", "deploy"], database.url);
  expect(await repository.getSnapshot()).toStrictEqual({
    books: [],
    series: [],
    categories: [],
  });
  expect(await seedCatalog(client)).toEqual(counts);
});

afterAll(async () => {
  // Attempt every close even if an earlier close fails; never DROP with FORCE.
  const closed = await Promise.allSettled([
    repository?.disconnect(),
    client?.$disconnect(),
    sql?.end(),
  ]);
  await database?.dispose();
  for (const result of closed) {
    if (result.status === "rejected") throw result.reason;
  }
});

describe("isolated catalog migrations and seed", () => {
  it("replays deploy idempotently and contains exactly the fourteen catalog tables", async () => {
    await runPrisma(["migrate", "deploy"], database.url);
    const migrations = await sql.query(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
    );
    expect(migrations.rows.map((row) => row.migration_name)).toEqual([
      "001_catalog_base",
      "002_catalog_invariants",
      "003_catalog_identity_checks",
      "004_security_identity",
      "005_security_foundation",
      "006_durable_admission_controls",
    ]);
    const tables = await sql.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename",
    );
    expect(tables.rows.map((row) => row.tablename)).toEqual([
      "Category",
      "Contributor",
      "Edition",
      "EditionContent",
      "EditionContributor",
      "Product",
      "Publisher",
      "Series",
      "SeriesWork",
      "Sku",
      "Volume",
      "Work",
      "WorkCategory",
      "WorkContributor",
    ]);
    const columns = await sql.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'",
    );
    expect(columns.rows.map((row) => row.column_name).join(" ")).not.toMatch(
      /price|stock|inventory|password|payment|checkout|customer|virtualBundle/i,
    );
  });

  it("seeds twice with stable internal UUIDs and exact public snapshot parity", async () => {
    const before = await client.product.findMany({
      orderBy: { curatedPosition: "asc" },
    });
    expect(await seedCatalog(client)).toEqual(counts);
    const after = await client.product.findMany({
      orderBy: { curatedPosition: "asc" },
    });
    expect(after.map(({ id, publicId }) => ({ id, publicId }))).toEqual(
      before.map(({ id, publicId }) => ({ id, publicId })),
    );
    for (const product of after) {
      expect(product.id).toMatch(/^[a-f0-9-]{36}$/);
      expect(product.id).not.toBe(product.publicId);
      expect(product.id).toBe(id("product", product.publicId));
      expect(product.isDemo).toBe(true);
    }
    expect(await client.publisher.count()).toBe(0);
    expect(
      await client.edition.count({ where: { publisherId: { not: null } } }),
    ).toBe(0);
    expect(
      await client.edition.count({ where: { isbn13: { not: null } } }),
    ).toBe(0);
    expect(await repository.getSnapshot()).toStrictEqual(fixture);
  });

  it("upgrades seeded base schema to reviewed invariants without changing identities or DTOs", async () => {
    const upgrade = await createDisposableDatabase();
    const raw = new Client({ connectionString: upgrade.url });
    const upgradeClient = createCatalogClient(upgrade.url);
    const read = new PostgresCatalogRepository(
      createCatalogClient(upgrade.url, { readOnly: true }),
    );
    try {
      await raw.connect();
      const baseSql = await readFile(
        new URL(
          "../../prisma/migrations/001_catalog_base/migration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await raw.query(baseSql);
      await runPrisma(
        ["migrate", "resolve", "--applied", "001_catalog_base"],
        upgrade.url,
      );
      expect(await seedCatalog(upgradeClient)).toEqual(counts);
      const before = await read.getSnapshot();
      const identities = await upgradeClient.product.findMany({
        orderBy: { curatedPosition: "asc" },
        select: { id: true, publicId: true },
      });
      await runPrisma(["migrate", "deploy"], upgrade.url);
      const applied = await raw.query(
        'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name',
      );
      expect(applied.rows.map((row) => row.migration_name)).toEqual([
        "001_catalog_base",
        "002_catalog_invariants",
        "003_catalog_identity_checks",
        "004_security_identity",
        "005_security_foundation",
        "006_durable_admission_controls",
      ]);
      expect(await read.getSnapshot()).toStrictEqual(before);
      expect(before).toStrictEqual(fixture);
      expect(
        await upgradeClient.product.findMany({
          orderBy: { curatedPosition: "asc" },
          select: { id: true, publicId: true },
        }),
      ).toEqual(identities);
    } finally {
      const closed = await Promise.allSettled([
        raw.end(),
        read.disconnect(),
        upgradeClient.$disconnect(),
      ]);
      await upgrade.dispose();
      for (const result of closed) {
        if (result.status === "rejected") throw result.reason;
      }
    }
  });
});

describe("public PostgreSQL read contract", () => {
  it("returns only exact public DTO keys, never database UUIDs or model metadata", async () => {
    const snapshot = await repository.getSnapshot();
    expect(snapshot).toStrictEqual(fixture);
    expect(Object.keys(snapshot).sort()).toEqual([
      "books",
      "categories",
      "series",
    ]);
    for (const book of snapshot.books) {
      const expected = books.find(({ id }) => id === book.id)!;
      expect(Object.keys(book).sort()).toEqual(Object.keys(expected).sort());
    }
    for (const item of snapshot.series) {
      expect(Object.keys(item).sort()).toEqual([
        "bookIds",
        "description",
        "id",
        "slug",
        "title",
      ]);
    }
    for (const item of snapshot.categories) {
      expect(Object.keys(item).sort()).toEqual(["description", "id", "label"]);
    }
    expect(JSON.stringify(snapshot)).not.toMatch(
      /"(?:isbn13|publisherId|createdAt|updatedAt|version|isDemo|primarySkuId|status|contents)"|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/,
    );
    snapshot.books[0].title = "mutated caller DTO";
    snapshot.series[0].bookIds.reverse();
    expect(await repository.getSnapshot()).toStrictEqual(fixture);
  });

  it("preserves shared Vietnamese query/category/title/recent and invalid-filter behavior", async () => {
    const snapshot = await repository.getSnapshot();
    for (const query of [
      "",
      "ĐÊM TRĂNG",
      "do may",
      "MÂY trăng ĐỖ mái",
      "Tiệm trà".normalize("NFD"),
      "xyz",
    ]) {
      for (const category of [
        undefined,
        "all",
        ...categories.map(({ id }) => id),
        " manga ",
        "invalid",
      ]) {
        for (const sort of [undefined, "title", "recent", "unsupported"]) {
          expect(
            discoverBooks(snapshot.books, { query, category, sort }),
          ).toStrictEqual(discoverBooks(books, { query, category, sort }));
        }
      }
    }
  });

  it("keeps standalone units unnumbered and omnibus content on the two original Volume rows", async () => {
    const volume = await client.volume.findUniqueOrThrow({
      where: { publicId: standalone.id },
    });
    expect(volume.label).toBeNull();
    expect(
      await client.seriesWork.count({ where: { workId: volume.workId } }),
    ).toBe(0);
    const snapshot = await repository.getSnapshot();
    expect(
      snapshot.books.find(({ id }) => id === standalone.id),
    ).not.toHaveProperty("seriesId");
    const content = await client.editionContent.findMany({
      where: { editionId: id("edition", omnibus.id) },
      orderBy: { position: "asc" },
    });
    expect(content.map(({ volumeId }) => volumeId)).toEqual([
      id("volume", "khu-vuon-sau-con-mua"),
      id("volume", "nhung-la-thu-gui-mua-thu"),
    ]);
    for (const item of content) {
      expect(
        await client.editionContent.count({
          where: { volumeId: item.volumeId },
        }),
      ).toBe(2);
    }
  });

  it("supports secondary Series membership without changing the primary ID or duplicating omnibus", async () => {
    const secondaryId = randomUUID();
    try {
      await client.series.create({
        data: {
          id: secondaryId,
          publicId: "synthetic-secondary",
          slug: "synthetic-secondary",
          title: "Synthetic test series",
          description: "Integration fixture only",
          curatedPosition: 100,
          status: "PUBLISHED",
          works: {
            create: {
              workId: id("work", first.seriesId!),
              position: 1,
              isPrimary: false,
            },
          },
        },
      });
      const snapshot = await repository.getSnapshot();
      const expected = books
        .filter((book) => book.seriesId === first.seriesId)
        .map(({ id }) => id);
      expect(
        snapshot.series.find(({ id }) => id === "synthetic-secondary")?.bookIds,
      ).toEqual(expected);
      expect(snapshot.books).toStrictEqual(books);
      await client.series.update({
        where: { id: secondaryId },
        data: { status: "DRAFT" },
      });
      expect(await repository.getSnapshot()).toStrictEqual(fixture);
    } finally {
      await client.seriesWork.deleteMany({ where: { seriesId: secondaryId } });
      await client.series.deleteMany({ where: { id: secondaryId } });
    }
  });

  it("orders multi-Work Series by membership and covered volume rather than global product order", async () => {
    const syntheticId = randomUUID();
    try {
      await client.series.create({
        data: {
          id: syntheticId,
          publicId: "synthetic-multi-work",
          slug: "synthetic-multi-work",
          title: "Synthetic ordered series",
          description: "Integration fixture only",
          curatedPosition: 100,
          status: "PUBLISHED",
          works: {
            create: [
              {
                workId: id("work", standalone.id),
                position: 1,
                isPrimary: false,
              },
              {
                workId: id("work", first.seriesId!),
                position: 2,
                isPrimary: false,
              },
            ],
          },
        },
      });
      const snapshot = await repository.getSnapshot();
      const expected = [
        standalone.id,
        ...series.find(({ id }) => id === first.seriesId)!.bookIds,
      ];
      expect(
        snapshot.series.find(({ id }) => id === "synthetic-multi-work")
          ?.bookIds,
      ).toEqual(expected);
      expect(new Set(expected).size).toBe(4);
      expect(expected[0]).not.toBe(books[0].id);
      // Global curation and legacy primary membership stay unchanged.
      expect(snapshot.books).toStrictEqual(books);
      expect(
        snapshot.series.filter(({ id }) => id !== "synthetic-multi-work"),
      ).toStrictEqual(series);
    } finally {
      await client.seriesWork.deleteMany({ where: { seriesId: syntheticId } });
      await client.series.deleteMany({ where: { id: syntheticId } });
    }
    expect(await repository.getSnapshot()).toStrictEqual(fixture);
  });

  it("projects a synthetic cross-Work anthology with ordered deduplicated authors", async () => {
    const editionId = randomUUID();
    const productId = randomUUID();
    const skuId = randomUUID();
    try {
      await client.edition.create({
        data: {
          id: editionId,
          publicId: "synthetic-anthology",
          editionLabel: "Test anthology",
          contentLabel: "Two content units",
          languageLabel: "Tiếng Việt",
          year: 2027,
          color: "gold",
          motif: "sun",
          status: "PUBLISHED",
          contents: {
            create: [
              { volumeId: id("volume", first.id), position: 1 },
              { volumeId: id("volume", standalone.id), position: 2 },
            ],
          },
        },
      });
      await client.product.create({
        data: {
          id: productId,
          publicId: "synthetic-anthology",
          slug: "synthetic-anthology",
          merchandisingTitle: "Synthetic anthology",
          description: "Integration fixture only",
          eyebrow: "Test only",
          curatedPosition: 100,
        },
      });
      await client.sku.create({
        data: {
          id: skuId,
          publicId: "synthetic-anthology",
          code: "TEST-ANTHOLOGY",
          productId,
          editionId,
        },
      });
      await client.product.update({
        where: { id: productId },
        data: { primarySkuId: skuId, status: "PUBLISHED" },
      });
      const snapshot = await repository.getSnapshot();
      expect(
        snapshot.books.find(({ id }) => id === "synthetic-anthology"),
      ).toStrictEqual({
        id: "synthetic-anthology",
        slug: "synthetic-anthology",
        title: "Synthetic anthology",
        author: `${first.author}, ${standalone.author}`,
        category: first.category,
        seriesId: first.seriesId,
        volume: "Two content units",
        edition: "Test anthology",
        language: "Tiếng Việt",
        description: "Integration fixture only",
        year: 2027,
        color: "gold",
        motif: "sun",
        eyebrow: "Test only",
      });
      expect(
        snapshot.series.find(({ id }) => id === first.seriesId)?.bookIds,
      ).toEqual([
        first.id,
        "synthetic-anthology",
        ...series.find(({ id }) => id === first.seriesId)!.bookIds.slice(1),
      ]);
    } finally {
      await client.product.updateMany({
        where: { id: productId },
        data: { status: "DRAFT", primarySkuId: null },
      });
      await client.sku.deleteMany({ where: { id: skuId } });
      await client.product.deleteMany({ where: { id: productId } });
      await client.editionContent.deleteMany({ where: { editionId } });
      await client.edition.deleteMany({ where: { id: editionId } });
    }
  });

  it.each(["Work", "Edition", "Product"] as const)(
    "never leaks a draft %s through joins",
    async (table) => {
      const publicKey = table === "Work" ? first.seriesId! : first.id;
      const entityId = id(table.toLowerCase(), publicKey);
      try {
        await sql.query(
          `UPDATE "${table}" SET "status" = 'DRAFT' WHERE "id" = $1`,
          [entityId],
        );
        const snapshot = await repository.getSnapshot();
        const excluded =
          table === "Work"
            ? books
                .filter((book) => book.seriesId === first.seriesId)
                .map(({ id }) => id)
            : [first.id];
        for (const publicId of excluded) {
          expect(snapshot.books.some(({ id }) => id === publicId)).toBe(false);
          expect(
            snapshot.series.some(({ bookIds }) => bookIds.includes(publicId)),
          ).toBe(false);
        }
      } finally {
        await sql.query(
          `UPDATE "${table}" SET "status" = 'PUBLISHED' WHERE "id" = $1`,
          [entityId],
        );
      }
      expect(await repository.getSnapshot()).toStrictEqual(fixture);
    },
  );

  it.each(["Product", "Work", "Edition"] as const)(
    "omits non-demo %s records throughout public joins",
    async (table) => {
      const publicKey = table === "Work" ? first.seriesId! : first.id;
      const entityId = id(table.toLowerCase(), publicKey);
      const excluded =
        table === "Work"
          ? books
              .filter((book) => book.seriesId === first.seriesId)
              .map(({ id }) => id)
          : [first.id];
      try {
        await sql.query(
          `UPDATE "${table}" SET "isDemo" = false WHERE "id" = $1`,
          [entityId],
        );
        const snapshot = await repository.getSnapshot();
        expect(snapshot.books).toStrictEqual(
          books.filter((book) => !excluded.includes(book.id)),
        );
        for (const publicId of excluded) {
          expect(
            snapshot.series.some(({ bookIds }) => bookIds.includes(publicId)),
          ).toBe(false);
        }
      } finally {
        await sql.query(
          `UPDATE "${table}" SET "isDemo" = true WHERE "id" = $1`,
          [entityId],
        );
      }
      expect(await repository.getSnapshot()).toStrictEqual(fixture);
    },
  );

  it("omits draft primary Series metadata and legacy seriesId while retaining eligible books", async () => {
    const seriesId = first.seriesId!;
    try {
      await client.series.update({
        where: { id: id("series", seriesId) },
        data: { status: "DRAFT" },
      });
      const snapshot = await repository.getSnapshot();
      const expectedBooks = structuredClone(books);
      for (const book of expectedBooks) {
        if (book.seriesId === seriesId) delete book.seriesId;
      }
      expect(snapshot.books).toStrictEqual(expectedBooks);
      expect(snapshot.series).toStrictEqual(
        series.filter(({ id }) => id !== seriesId),
      );
      expect(snapshot.categories).toStrictEqual(categories);
      expect(snapshot.series.some(({ id }) => id === seriesId)).toBe(false);
    } finally {
      await client.series.update({
        where: { id: id("series", seriesId) },
        data: { status: "PUBLISHED" },
      });
    }
    expect(await repository.getSnapshot()).toStrictEqual(fixture);
  });

  it("omits non-demo categories and all books that would depend on them", async () => {
    const categoryId = first.category;
    const excluded = books
      .filter((book) => book.category === categoryId)
      .map(({ id }) => id);
    try {
      await client.category.update({
        where: { id: id("category", categoryId) },
        data: { isDemo: false },
      });
      const snapshot = await repository.getSnapshot();
      expect(snapshot.categories).toStrictEqual(
        categories.filter(({ id }) => id !== categoryId),
      );
      expect(snapshot.books).toStrictEqual(
        books.filter((book) => !excluded.includes(book.id)),
      );
      for (const publicId of excluded) {
        expect(
          snapshot.series.some(({ bookIds }) => bookIds.includes(publicId)),
        ).toBe(false);
      }
    } finally {
      await client.category.update({
        where: { id: id("category", categoryId) },
        data: { isDemo: true },
      });
    }
    expect(await repository.getSnapshot()).toStrictEqual(fixture);
  });

  it.each(["year", "content", "category", "author"])(
    "omits incomplete %s instead of inventing metadata",
    async (missing) => {
      // Use a standalone so relation removal affects one public product only.
      const workId = id("work", standalone.id);
      const editionId = id("edition", standalone.id);
      try {
        if (missing === "year")
          await sql.query(
            'UPDATE "Edition" SET "year" = NULL WHERE "id" = $1',
            [editionId],
          );
        if (missing === "content")
          await sql.query(
            'DELETE FROM "EditionContent" WHERE "editionId" = $1',
            [editionId],
          );
        if (missing === "category")
          await sql.query('DELETE FROM "WorkCategory" WHERE "workId" = $1', [
            workId,
          ]);
        if (missing === "author")
          await sql.query('DELETE FROM "WorkContributor" WHERE "workId" = $1', [
            workId,
          ]);
        expect(
          (await repository.getSnapshot()).books.some(
            ({ id }) => id === standalone.id,
          ),
        ).toBe(false);
      } finally {
        await seedCatalog(client);
      }
      expect(await repository.getSnapshot()).toStrictEqual(fixture);
    },
  );

  it("uses a genuinely read-only factory client", async () => {
    const readOnly = createCatalogClient(database.url, { readOnly: true });
    try {
      await expect(
        readOnly.$executeRawUnsafe(
          'UPDATE "Product" SET "eyebrow" = "eyebrow"',
        ),
      ).rejects.toThrow();
      expect(
        await new PostgresCatalogRepository(readOnly).getSnapshot(),
      ).toStrictEqual(fixture);
    } finally {
      await readOnly.$disconnect();
    }
  });

  it("propagates a real missing-database read failure without fixture fallback", async () => {
    const missing = new URL(database.url);
    // A fresh random name is allowlisted but is deliberately never created.
    missing.pathname = `/bookstore_catalog_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const brokenClient = createCatalogClient(missing.toString(), {
      readOnly: true,
    });
    try {
      const result = await createCatalogRepository({
        env: { DATA_SOURCE: "database", DATABASE_URL: missing.toString() },
        databaseFactory: () => new PostgresCatalogRepository(brokenClient),
      });
      await expect(result.getSnapshot()).rejects.toThrow();
    } finally {
      await brokenClient.$disconnect();
    }
    // Exercise the public URL factory too; it remains selected explicitly.
    const factoryRepository = createPostgresCatalogRepository(database.url);
    try {
      expect(await factoryRepository.getSnapshot()).toStrictEqual(fixture);
    } finally {
      await (factoryRepository as PostgresCatalogRepository).disconnect();
    }
  });
});

describe("database-enforced catalog integrity", () => {
  it.each([
    [
      'UPDATE "Product" SET "publicId" = \'\' WHERE "id" = $1',
      id("product", first.id),
    ],
    [
      'UPDATE "Product" SET "publicId" = \' \' WHERE "id" = $1',
      id("product", first.id),
    ],
    [
      'UPDATE "Product" SET "slug" = \'bad/slug\' WHERE "id" = $1',
      id("product", first.id),
    ],
    ['UPDATE "Sku" SET "code" = \'\' WHERE "id" = $1', id("sku", first.id)],
    [
      'UPDATE "Work" SET "version" = -1 WHERE "id" = $1',
      id("work", first.seriesId!),
    ],
    [
      'UPDATE "Edition" SET "year" = 0 WHERE "id" = $1',
      id("edition", first.id),
    ],
    [
      'UPDATE "Volume" SET "sortOrder" = 0 WHERE "id" = $1',
      id("volume", first.id),
    ],
    [
      'UPDATE "EditionContent" SET "position" = 0 WHERE "editionId" = $1',
      id("edition", first.id),
    ],
    [
      'UPDATE "WorkCategory" SET "rank" = 0 WHERE "workId" = $1',
      id("work", first.seriesId!),
    ],
    [
      'UPDATE "WorkContributor" SET "position" = 0 WHERE "workId" = $1',
      id("work", first.seriesId!),
    ],
    [
      'UPDATE "SeriesWork" SET "position" = 0 WHERE "workId" = $1',
      id("work", first.seriesId!),
    ],
    [
      'UPDATE "Product" SET "curatedPosition" = 0 WHERE "id" = $1',
      id("product", first.id),
    ],
    [
      'UPDATE "Edition" SET "isbn13" = \'9780306406158\' WHERE "id" = $1',
      id("edition", first.id),
    ],
    [
      'UPDATE "Edition" SET "isbn13" = \'not-an-isbn\' WHERE "id" = $1',
      id("edition", first.id),
    ],
    [
      'UPDATE "Product" SET "primarySkuId" = NULL WHERE "id" = $1',
      id("product", first.id),
    ],
    [
      'UPDATE "Sku" SET "editionId" = NULL WHERE "id" = $1',
      id("sku", first.id),
    ],
    [
      'UPDATE "Sku" SET "kind" = \'PREPACKED\' WHERE "id" = $1',
      id("sku", first.id),
    ],
  ])("rejects CHECK violation: %s", async (query, entityId) => {
    await expectSqlError(query, [entityId], "23514");
  });

  it("enforces foreign keys, restricted deletes and same-product primary SKU ownership", async () => {
    await expectSqlError(
      'UPDATE "Volume" SET "workId" = $1 WHERE "id" = $2',
      [randomUUID(), id("volume", first.id)],
      "23503",
    );
    await expectSqlError(
      'DELETE FROM "Work" WHERE "id" = $1',
      [id("work", first.seriesId!)],
      "23001", // PostgreSQL 18 reports ON DELETE RESTRICT as restrict_violation.
    );
    await expectSqlError(
      'UPDATE "Product" SET "primarySkuId" = $1 WHERE "id" = $2',
      [id("sku", books[1].id), id("product", first.id)],
      "23503",
    );
  });

  it("enforces unique public IDs/slugs, ordering pairs and one primary Series per Work", async () => {
    await expectSqlError(
      'UPDATE "Product" SET "publicId" = $1 WHERE "id" = $2',
      [first.id, id("product", books[1].id)],
      "23505",
    );
    await expectSqlError(
      'UPDATE "Product" SET "slug" = $1 WHERE "id" = $2',
      [first.slug, id("product", books[1].id)],
      "23505",
    );
    await expectSqlError(
      'UPDATE "Sku" SET "code" = $1 WHERE "id" = $2',
      [`DEMO-${first.id}`, id("sku", books[1].id)],
      "23505",
    );
    await expectSqlError(
      'UPDATE "Volume" SET "sortOrder" = 1 WHERE "id" = $1',
      [id("volume", "nhung-la-thu-gui-mua-thu")],
      "23505",
    );
    await expectSqlError(
      'INSERT INTO "SeriesWork" ("seriesId", "workId", "position", "isPrimary") VALUES ($1, $2, 2, true)',
      [id("series", series[1].id), id("work", first.seriesId!)],
      "23505",
    );
  });

  it("accepts valid normalized ISBN checksum but rejects duplicates", async () => {
    await sql.query("BEGIN");
    try {
      await sql.query('UPDATE "Edition" SET "isbn13" = $1 WHERE "id" = $2', [
        "9780306406157",
        id("edition", first.id),
      ]);
      await expect(
        sql.query('UPDATE "Edition" SET "isbn13" = $1 WHERE "id" = $2', [
          "9780306406157",
          id("edition", books[1].id),
        ]),
      ).rejects.toMatchObject({ code: "23505" });
    } finally {
      await sql.query("ROLLBACK");
    }
  });

  it("allows an edition-free PREPACKED identity but never treats it as a public book", async () => {
    const productId = randomUUID();
    const skuId = randomUUID();
    try {
      await client.product.create({
        data: {
          id: productId,
          publicId: "synthetic-prepacked",
          slug: "synthetic-prepacked",
          merchandisingTitle: "Synthetic prepacked",
          description: "Test only",
          eyebrow: "Test only",
          curatedPosition: 101,
        },
      });
      await client.sku.create({
        data: {
          id: skuId,
          publicId: "synthetic-prepacked",
          code: "TEST-PREPACKED",
          productId,
          kind: "PREPACKED",
          editionId: null,
        },
      });
      await client.product.update({
        where: { id: productId },
        data: { primarySkuId: skuId, status: "PUBLISHED" },
      });
      expect(await repository.getSnapshot()).toStrictEqual(fixture);
    } finally {
      await client.product.updateMany({
        where: { id: productId },
        data: { status: "DRAFT", primarySkuId: null },
      });
      await client.sku.deleteMany({ where: { id: skuId } });
      await client.product.deleteMany({ where: { id: productId } });
    }
  });
});
