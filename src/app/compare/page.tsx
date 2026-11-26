import Link from "next/link";
import { readCatalog } from "@/modules/catalog/read-catalog";

export const metadata = { title: "So sánh sách" };

type Params = Record<string, string | string[] | undefined>;

function isSlug(value: Params[string]): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !/[/?#\\\s\u0000-\u001f\u007f]/u.test(value)
  );
}

function display(value: string | number | undefined) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value > 0 ? value : "Chưa có thông tin";
  }
  return value?.trim() ? value : "Chưa có thông tin";
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Params>;
}) {
  const params = await searchParams;
  const first = params.book;
  const second = params.with;
  const { books, series } = await readCatalog();
  const left = isSlug(first)
    ? books.find((book) => book.slug === first)
    : undefined;
  const right = isSlug(second)
    ? books.find((book) => book.slug === second)
    : undefined;
  const collection =
    left && right && left.id !== right.id && first !== second
      ? series.find(
          (item) =>
            item.bookIds.includes(left.id) && item.bookIds.includes(right.id),
        )
      : undefined;

  return (
    <div className="container">
      <div className="page-heading">
        <h1>So sánh sách</h1>
        {collection && <p>{collection.title}</p>}
      </div>
      <div className="page-body">
        {left && right && collection ? (
          <table
            className="notice"
            aria-label="Thông tin hai cuốn sách"
            style={{
              width: "100%",
              tableLayout: "fixed",
              overflowWrap: "anywhere",
              textAlign: "left",
            }}
          >
            <thead>
              <tr>
                <th scope="col">Thông tin</th>
                {[left, right].map((book) => (
                  <th key={book.id} scope="col">
                    <Link
                      href={`/products/${encodeURIComponent(book.slug)}`}
                      style={{ textDecoration: "underline" }}
                    >
                      {display(book.title)}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ["Tập / nội dung", "volume"],
                  ["Ấn bản minh họa", "edition"],
                  ["Ngôn ngữ", "language"],
                  ["Năm xuất bản (minh họa)", "year"],
                ] as const
              ).map(([label, key]) => (
                <tr key={key}>
                  <th scope="row" style={{ paddingBlock: "0.5em" }}>
                    {label}
                  </th>
                  <td>{display(left[key])}</td>
                  <td>{display(right[key])}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="notice">
            <h2>Không thể so sánh lựa chọn này</h2>
            <p>
              Hãy mở một trang sách và chọn hai cuốn khác nhau trong cùng bộ
              truyện.
            </p>
          </div>
        )}
        <p>
          <Link className="text-link" href="/catalog">
            Trở lại kệ sách
          </Link>
        </p>
      </div>
    </div>
  );
}
