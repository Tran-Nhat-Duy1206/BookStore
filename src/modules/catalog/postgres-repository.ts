import { createCatalogClient } from "../../server/database/client";
import type { Book, CatalogReadRepository, CatalogSnapshot } from "./contracts";

function isColor(value: string): value is Book["color"] {
  return ["forest", "clay", "navy", "gold", "plum", "sage"].includes(value);
}

function isMotif(value: string): value is Book["motif"] {
  return ["moon", "mountain", "botanical", "stars", "waves", "sun"].includes(
    value,
  );
}

function isNonblank(value: string): boolean {
  return value.trim().length > 0;
}
type Placement = [number, number, number, number];
function comparePlacement(a: Placement, b: Placement): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Projects normalized catalog records to the unchanged public fixture DTOs. */
export class PostgresCatalogRepository implements CatalogReadRepository {
  constructor(
    private readonly client: ReturnType<typeof createCatalogClient>,
  ) {}

  async getSnapshot(): Promise<CatalogSnapshot> {
    const [products, publishedSeries, categories] =
      await this.client.$transaction(
        [
          this.client.product.findMany({
            where: {
              status: "PUBLISHED",
              isDemo: true,
              primarySku: {
                is: {
                  isDemo: true,
                  edition: {
                    is: {
                      status: "PUBLISHED",
                      isDemo: true,
                      contents: {
                        some: {},
                        every: {
                          isDemo: true,
                          volume: {
                            isDemo: true,
                            work: { status: "PUBLISHED", isDemo: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            orderBy: { curatedPosition: "asc" },
            select: {
              id: true,
              publicId: true,
              slug: true,
              merchandisingTitle: true,
              description: true,
              eyebrow: true,
              curatedPosition: true,
              primarySku: {
                select: {
                  productId: true,
                  edition: {
                    select: {
                      editionLabel: true,
                      contentLabel: true,
                      languageLabel: true,
                      year: true,
                      color: true,
                      motif: true,
                      contents: {
                        orderBy: { position: "asc" },
                        select: {
                          volume: {
                            select: {
                              sortOrder: true,
                              work: {
                                select: {
                                  status: true,
                                  categories: {
                                    where: {
                                      isDemo: true,
                                      category: { isDemo: true },
                                    },
                                    orderBy: { rank: "asc" },
                                    select: {
                                      category: {
                                        select: { publicId: true },
                                      },
                                    },
                                  },
                                  contributors: {
                                    where: {
                                      role: "AUTHOR",
                                      isDemo: true,
                                      contributor: { isDemo: true },
                                    },
                                    orderBy: { position: "asc" },
                                    select: {
                                      contributor: { select: { name: true } },
                                    },
                                  },
                                  series: {
                                    where: {
                                      isDemo: true,
                                      series: {
                                        status: "PUBLISHED",
                                        isDemo: true,
                                      },
                                    },
                                    orderBy: { position: "asc" },
                                    select: {
                                      isPrimary: true,
                                      position: true,
                                      series: { select: { publicId: true } },
                                    },
                                  },
                                },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          }),
          this.client.series.findMany({
            where: { status: "PUBLISHED", isDemo: true },
            orderBy: { curatedPosition: "asc" },
            select: {
              publicId: true,
              slug: true,
              title: true,
              description: true,
            },
          }),
          this.client.category.findMany({
            where: { isDemo: true },
            orderBy: { curatedPosition: "asc" },
            select: { publicId: true, label: true, description: true },
          }),
        ],
        { isolationLevel: "RepeatableRead" },
      );

    const books: Book[] = [];
    const memberships = new Map<string, Map<string, Placement>>();
    for (const product of products) {
      const sku = product.primarySku;
      const edition = sku?.edition;
      if (!sku || sku.productId !== product.id || !edition) continue;
      const works = edition.contents.map(({ volume }) => volume.work);
      const firstWork = works[0];
      if (
        !firstWork ||
        works.some(
          (work) =>
            work.status !== "PUBLISHED" ||
            !work.categories.length ||
            !isNonblank(work.categories[0].category.publicId) ||
            !work.contributors.length ||
            work.contributors.some(
              ({ contributor }) => !isNonblank(contributor.name),
            ),
        ) ||
        typeof edition.year !== "number" ||
        !Number.isInteger(edition.year) ||
        edition.year < 1 ||
        edition.year > 9999 ||
        !isColor(edition.color) ||
        !isMotif(edition.motif) ||
        ![
          product.publicId,
          product.slug,
          product.merchandisingTitle,
          product.description,
          product.eyebrow,
          edition.editionLabel,
          edition.contentLabel,
          edition.languageLabel,
        ].every(isNonblank)
      ) {
        continue;
      }

      const authors = [
        ...new Set(
          works.flatMap((work) =>
            work.contributors.map(({ contributor }) => contributor.name),
          ),
        ),
      ];
      const primarySeries = firstWork.series.find(({ isPrimary }) => isPrimary);
      books.push({
        id: product.publicId,
        slug: product.slug,
        title: product.merchandisingTitle,
        author: authors.join(", "),
        category: firstWork.categories[0].category.publicId,
        ...(primarySeries ? { seriesId: primarySeries.series.publicId } : {}),
        volume: edition.contentLabel,
        edition: edition.editionLabel,
        language: edition.languageLabel,
        description: product.description,
        year: edition.year,
        color: edition.color,
        motif: edition.motif,
        eyebrow: product.eyebrow,
      });
      const placements = new Map<string, Placement>();
      for (const { volume } of edition.contents) {
        for (const membership of volume.work.series) {
          // Place a collected edition after the last unit it covers, with
          // standalone editions before omnibus at the same end position.
          const candidate: Placement = [
            membership.position,
            volume.sortOrder,
            edition.contents.length,
            product.curatedPosition,
          ];
          const previous = placements.get(membership.series.publicId);
          if (!previous || comparePlacement(previous, candidate) < 0)
            placements.set(membership.series.publicId, candidate);
        }
      }
      memberships.set(product.publicId, placements);
    }

    return {
      books,
      series: publishedSeries.map((series) => ({
        id: series.publicId,
        slug: series.slug,
        title: series.title,
        description: series.description,
        bookIds: books
          .filter((book) => memberships.get(book.id)?.has(series.publicId))
          .sort((a, b) =>
            comparePlacement(
              memberships.get(a.id)!.get(series.publicId)!,
              memberships.get(b.id)!.get(series.publicId)!,
            ),
          )
          .map((book) => book.id),
      })),
      categories: categories.map((category) => ({
        id: category.publicId,
        label: category.label,
        description: category.description,
      })),
    };
  }

  /** The owner controls lifetime; reads never disconnect a shared/cached client. */
  async disconnect(): Promise<void> {
    await this.client.$disconnect();
  }
}

/** Explicit selection only: constructing/importing this module does not connect. */
export function createPostgresCatalogRepository(
  url: string,
): CatalogReadRepository {
  return new PostgresCatalogRepository(
    createCatalogClient(url, { readOnly: true }),
  );
}
