import "server-only";
import { cache } from "react";
import { createCatalogRepository, resolveDataSource } from "./data-source";
import type { CatalogReadRepository } from "./contracts";
import { assertLocalReadMode } from "../../server/database/config";

// Cache a single initialization promise before awaiting imports. This avoids
// duplicate cold-request pools and survives development HMR without pooling leaks.
const runtime = globalThis as typeof globalThis & {
  __bookstoreCatalogRead?: {
    url: string;
    repository: Promise<CatalogReadRepository>;
  };
};

/** Per-request memoization only: no persistent cache of draft/old-source data. */
export const readCatalog = cache(async () => {
  if (resolveDataSource() === "database") assertLocalReadMode();
  const repository = await createCatalogRepository({
    databaseFactory: async (url) => {
      if (
        runtime.__bookstoreCatalogRead &&
        runtime.__bookstoreCatalogRead.url !== url
      )
        throw new Error(
          "Restart the server before changing the database configuration.",
        );
      if (!runtime.__bookstoreCatalogRead) {
        runtime.__bookstoreCatalogRead = {
          url,
          repository: import("./postgres-repository").then(
            ({ createPostgresCatalogRepository }) =>
              createPostgresCatalogRepository(url),
          ),
        };
      }
      return runtime.__bookstoreCatalogRead.repository;
    },
  });
  return repository.getSnapshot();
});
