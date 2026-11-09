import type { Book, Category, Series } from "./data";

export type { Book, Category, Series } from "./data";

/** Existing public catalog DTOs only; persistence identities stay in adapters. */
export type CatalogSnapshot = {
  books: Book[];
  series: Series[];
  categories: Category[];
};

export interface CatalogReadRepository {
  getSnapshot(): Promise<CatalogSnapshot>;
}
