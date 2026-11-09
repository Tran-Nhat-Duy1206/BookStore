import type { CatalogReadRepository, CatalogSnapshot } from "./contracts";
import { books, categories, series } from "./data";

export class FixtureCatalogRepository implements CatalogReadRepository {
  async getSnapshot(): Promise<CatalogSnapshot> {
    return structuredClone({ books, series, categories });
  }
}
