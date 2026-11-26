import type { Category } from "./contracts";

export type FilterParams = Record<string, string | string[] | undefined>;

export type CatalogFilters = {
  q: string;
  category: string;
  sort: "default" | "title" | "recent";
};

export function readCatalogFilters(
  params: FilterParams,
  categories: readonly Category[],
): CatalogFilters {
  // Repeated fields are arrays in Next. Ignore them rather than choosing a winner.
  const q = typeof params.q === "string" ? params.q : "";
  const requestedCategory =
    typeof params.category === "string" ? params.category.trim() : "all";
  const category = categories.some(({ id }) => id === requestedCategory)
    ? requestedCategory
    : "all";
  const requestedSort =
    typeof params.sort === "string" ? params.sort.trim() : "default";
  const sort =
    requestedSort === "title" || requestedSort === "recent"
      ? requestedSort
      : "default";
  return { q, category, sort };
}

export function catalogFilterSuffix({ q, category, sort }: CatalogFilters) {
  const filters = new URLSearchParams();
  if (q) filters.set("q", q);
  if (category !== "all") filters.set("category", category);
  if (sort !== "default") filters.set("sort", sort);
  const query = filters.toString();
  return query ? `?${query}` : "";
}
