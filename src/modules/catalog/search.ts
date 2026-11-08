import type { Book } from "./data";

/** Chuẩn hóa cả dấu thanh tiếng Việt và chữ đ để tìm kiếm không dấu. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[đĐ]/g, "d")
    .toLocaleLowerCase("vi-VN")
    .trim()
    .replace(/\s+/g, " ");
}

export type DiscoverOptions = {
  query?: string;
  category?: string;
  sort?: string;
};

/** Lọc trên bản sao; mặc định giữ nguyên thứ tự biên tập của dữ liệu đầu vào. */
export function discoverBooks(
  items: readonly Book[],
  options: DiscoverOptions = {},
): Book[] {
  const query = normalizeSearch(options.query ?? "");
  const terms = query.split(" ").filter(Boolean);
  const category = options.category?.trim();
  const results = items.filter((book) => {
    if (category && category !== "all" && book.category !== category)
      return false;
    if (!terms.length) return true;
    const searchable = normalizeSearch(
      [
        book.title,
        book.author,
        book.description,
        book.eyebrow,
        book.category,
        book.volume,
        book.edition,
        book.language,
      ].join(" "),
    );
    return terms.every((term) => searchable.includes(term));
  });

  if (options.sort === "title") {
    results.sort((a, b) => a.title.localeCompare(b.title, "vi-VN"));
  } else if (options.sort === "recent") {
    results.sort((a, b) => b.year - a.year);
  }
  return results;
}
