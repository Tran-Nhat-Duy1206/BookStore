import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { books, categories, series } from "../src/modules/catalog/data";
import type { PrismaClient } from "../src/generated/prisma/client";
import { createCatalogClient } from "../src/server/database/client";

// UUID v5, fixed application namespace + entity-qualified UTF-8 string.
// IDs are independent of array position, process, database and editable slugs.
const namespace = "d578791e-53bd-5d4b-b23c-d8688b47cf57";
export function catalogSeedId(entity: string, publicId: string): string {
  const bytes = createHash("sha1")
    .update(Buffer.from(namespace.replaceAll("-", ""), "hex"))
    .update(`${entity}:${publicId}`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const omnibusId = "nhung-mua-o-lung-may-hop-tuyen";
const lungMayVolumes = ["khu-vuon-sau-con-mua", "nhung-la-thu-gui-mua-thu"];

/** Imports only the original demo catalog; never truncates or deletes any rows. */
export async function seedCatalog(client: PrismaClient) {
  return client.$transaction(
    async (tx) => {
      for (const [index, category] of categories.entries()) {
        const data = {
          publicId: category.id,
          slug: category.id,
          label: category.label,
          description: category.description,
          curatedPosition: index + 1,
          isDemo: true,
        };
        await tx.category.upsert({
          where: { id: catalogSeedId("category", category.id) },
          create: { id: catalogSeedId("category", category.id), ...data },
          update: data,
        });
      }
      for (const [index, item] of series.entries()) {
        const data = {
          publicId: item.id,
          slug: item.slug,
          title: item.title,
          description: item.description,
          curatedPosition: index + 1,
          status: "PUBLISHED" as const,
          isDemo: true,
        };
        await tx.series.upsert({
          where: { id: catalogSeedId("series", item.id) },
          create: { id: catalogSeedId("series", item.id), ...data },
          update: data,
        });
      }

      // Two series-backed multi-volume Works and seven standalone Works.
      // The omnibus reuses units; it does not create another Work or Volume.
      const workKeys = new Set<string>();
      const volumeKeys: string[] = [];
      for (const book of books) {
        if (book.id === omnibusId) continue;
        const workKey = book.seriesId ?? book.id;
        const workId = catalogSeedId("work", workKey);
        const seriesFixture = series.find((item) => item.id === book.seriesId);
        if (!workKeys.has(workKey)) {
          workKeys.add(workKey);
          const work = {
            publicId: workKey,
            slug: seriesFixture?.slug ?? book.slug,
            title: seriesFixture?.title ?? book.title,
            description: seriesFixture?.description ?? book.description,
            status: "PUBLISHED" as const,
            isDemo: true,
          };
          await tx.work.upsert({
            where: { id: workId },
            create: { id: workId, ...work },
            update: work,
          });
          const contributorId = catalogSeedId("contributor", book.author);
          const contributor = {
            publicId: `author:${book.author}`,
            name: book.author,
            isDemo: true,
          };
          await tx.contributor.upsert({
            where: { id: contributorId },
            create: { id: contributorId, ...contributor },
            update: contributor,
          });
          await tx.workContributor.upsert({
            where: {
              workId_contributorId_role: {
                workId,
                contributorId,
                role: "AUTHOR",
              },
            },
            create: {
              workId,
              contributorId,
              role: "AUTHOR",
              position: 1,
              isDemo: true,
            },
            update: { position: 1, isDemo: true },
          });
          const categoryId = catalogSeedId("category", book.category);
          await tx.workCategory.upsert({
            where: { workId_categoryId: { workId, categoryId } },
            create: { workId, categoryId, rank: 1, isDemo: true },
            update: { rank: 1, isDemo: true },
          });
          if (book.seriesId) {
            const seriesId = catalogSeedId("series", book.seriesId);
            await tx.seriesWork.upsert({
              where: { seriesId_workId: { seriesId, workId } },
              create: {
                seriesId,
                workId,
                position: 1,
                isPrimary: true,
                isDemo: true,
              },
              update: { position: 1, isPrimary: true, isDemo: true },
            });
          }
        }
        volumeKeys.push(book.id);
        const volume = {
          publicId: book.id,
          workId,
          // Standalone has an unnumbered internal unit, not a fabricated “Tập 1”.
          label: book.seriesId ? book.volume : null,
          sortOrder:
            book.seriesId && seriesFixture
              ? seriesFixture.bookIds.indexOf(book.id) + 1
              : 1,
          isDemo: true,
        };
        await tx.volume.upsert({
          where: { id: catalogSeedId("volume", book.id) },
          create: { id: catalogSeedId("volume", book.id), ...volume },
          update: volume,
        });
      }

      for (const [index, book] of books.entries()) {
        const editionId = catalogSeedId("edition", book.id);
        const productId = catalogSeedId("product", book.id);
        const skuId = catalogSeedId("sku", book.id);
        const edition = {
          publicId: book.id,
          editionLabel: book.edition,
          contentLabel: book.volume,
          languageLabel: book.language,
          year: book.year,
          color: book.color,
          motif: book.motif,
          isbn13: null,
          publisherId: null,
          status: "PUBLISHED" as const,
          isDemo: true,
        };
        await tx.edition.upsert({
          where: { id: editionId },
          create: { id: editionId, ...edition },
          update: edition,
        });
        const units = book.id === omnibusId ? lungMayVolumes : [book.id];
        for (const [position, unit] of units.entries()) {
          const volumeId = catalogSeedId("volume", unit);
          await tx.editionContent.upsert({
            where: { editionId_volumeId: { editionId, volumeId } },
            create: {
              editionId,
              volumeId,
              position: position + 1,
              isDemo: true,
            },
            update: { position: position + 1, isDemo: true },
          });
        }
        const product = {
          publicId: book.id,
          slug: book.slug,
          merchandisingTitle: book.title,
          description: book.description,
          eyebrow: book.eyebrow,
          curatedPosition: index + 1,
          isDemo: true,
        };
        await tx.product.upsert({
          where: { id: productId },
          create: { id: productId, ...product, status: "DRAFT" },
          update: product,
        });
        const sku = {
          publicId: book.id,
          code: `DEMO-${book.id}`,
          productId,
          editionId,
          kind: "SINGLE_BOOK" as const,
          isDemo: true,
        };
        await tx.sku.upsert({
          where: { id: skuId },
          create: { id: skuId, ...sku },
          update: sku,
        });
        // Select an owned SKU only after it exists; published rows cannot be incomplete.
        await tx.product.update({
          where: { id: productId },
          data: { primarySkuId: skuId, status: "PUBLISHED" },
        });
      }

      // Counts are scoped to seeded identities, never unrelated existing records.
      return {
        works: await tx.work.count({
          where: {
            id: { in: [...workKeys].map((key) => catalogSeedId("work", key)) },
          },
        }),
        volumes: await tx.volume.count({
          where: {
            id: { in: volumeKeys.map((key) => catalogSeedId("volume", key)) },
          },
        }),
        editions: await tx.edition.count({
          where: {
            id: { in: books.map((book) => catalogSeedId("edition", book.id)) },
          },
        }),
        products: await tx.product.count({
          where: {
            id: { in: books.map((book) => catalogSeedId("product", book.id)) },
          },
        }),
        skus: await tx.sku.count({
          where: {
            id: { in: books.map((book) => catalogSeedId("sku", book.id)) },
          },
        }),
        categories: await tx.category.count({
          where: {
            id: {
              in: categories.map((item) => catalogSeedId("category", item.id)),
            },
          },
        }),
        series: await tx.series.count({
          where: {
            id: { in: series.map((item) => catalogSeedId("series", item.id)) },
          },
        }),
      };
    },
    { maxWait: 10_000, timeout: 60_000 },
  );
}

async function main() {
  const { config } = await import("dotenv");
  config({ path: ".env.local", quiet: true });
  // The factory validates before constructing an adapter/connecting. No fallback.
  const client = createCatalogClient(process.env.DATABASE_URL ?? "");
  try {
    const counts = await seedCatalog(client);
    console.log("Demo catalog seeded:", counts);
  } finally {
    await client.$disconnect();
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  void main().catch(() => {
    // Driver/config errors can include connection strings; never print them.
    console.error(
      "Catalog seed failed. Verify the isolated BookStore database configuration.",
    );
    process.exitCode = 1;
  });
}
