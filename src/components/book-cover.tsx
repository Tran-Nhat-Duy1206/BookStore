import type { Book } from "@/modules/catalog/data";

/** Original geometric artwork, authored for this project; no external cover assets. */
export function BookCover({ book }: { book: Book }) {
  return (
    <div
      className={`book-cover cover-${book.color}`}
      role="img"
      aria-label={`Bìa minh họa gốc: ${book.title}`}
    >
      <span className="cover-author">{book.author}</span>
      <span className="cover-title">{book.title}</span>
      <svg
        className={`cover-art motif-${book.motif}`}
        viewBox="0 0 200 210"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="100" cy="83" r="42" className="art-sun" />
        <path
          d="M20 181C39 120 71 154 100 91C123 147 158 112 183 181Z"
          className="art-mountain"
        />
        <path
          d="M100 189V89M100 139C48 139 43 100 48 88C88 88 100 113 100 139ZM100 165C153 164 160 124 154 109C114 111 100 139 100 165ZM100 114C65 91 74 59 100 40C126 61 136 89 100 114Z"
          className="art-plant"
        />
        <path
          d="M14 155Q57 119 100 155T186 155M14 174Q57 138 100 174T186 174M14 193Q57 157 100 193T186 193"
          className="art-waves"
        />
        <path
          d="m41 55 3 9 10 3-10 3-3 10-3-10-10-3 10-3ZM156 93l4 12 12 4-12 4-4 12-4-12-12-4 12-4Z"
          className="art-stars"
        />
        <circle cx="146" cy="46" r="3" />
        <circle cx="36" cy="117" r="2" />
      </svg>
      <span className="cover-bottom">
        {book.volume} <span>ẤN BẢN MINH HỌA</span>
      </span>
    </div>
  );
}
