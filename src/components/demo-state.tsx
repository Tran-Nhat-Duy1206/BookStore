"use client";

import {
  createContext,
  useContext,
  useSyncExternalStore,
  useState,
  useRef,
  type ReactNode,
} from "react";
import { Heart, ShoppingBag, Minus, Plus, Trash2 } from "lucide-react";
import { books } from "@/modules/catalog/data";
import { BookCover } from "./book-cover";
import Link from "next/link";

type Snapshot = { wishlist: string[]; cart: Record<string, number> };
const storageKey = "bookstore-demo-v1";
const empty: Snapshot = { wishlist: [], cart: {} };
let current = empty;
const subscribers = new Set<() => void>();
let loaded = false;
let storageAvailable = true;
function load(force = false) {
  if ((loaded && !force) || !storageAvailable) return;
  loaded = true;
  let stored: string | null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    storageAvailable = false;
    return;
  }
  try {
    const raw = JSON.parse(stored || "{}");
    const valid = new Set(books.map((b) => b.id));
    const next: Snapshot = {
      wishlist: Array.isArray(raw?.wishlist)
        ? [
            ...new Set<string>(
              raw.wishlist.filter(
                (id: unknown) => typeof id === "string" && valid.has(id),
              ),
            ),
          ]
        : [],
      cart: {},
    };
    if (raw?.cart && typeof raw.cart === "object")
      for (const [id, n] of Object.entries(raw.cart))
        if (valid.has(id) && Number.isInteger(n) && Number(n) > 0)
          next.cart[id] = Math.min(Number(n), 9);
    current = next;
  } catch {
    current = empty;
  }
}
function syncStorage(event: StorageEvent) {
  if (event.key === storageKey || event.key === null) {
    load(true);
    subscribers.forEach((fn) => fn());
  }
}
function subscribe(callback: () => void) {
  if (subscribers.size === 0) window.addEventListener("storage", syncStorage);
  subscribers.add(callback);
  load();
  callback();
  return () => {
    subscribers.delete(callback);
    if (subscribers.size === 0)
      window.removeEventListener("storage", syncStorage);
  };
}
function update(value: Snapshot) {
  current = value;
  try {
    localStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    storageAvailable = false;
  }
  subscribers.forEach((fn) => fn());
  return storageAvailable;
}
const DemoContext = createContext<{
  state: Snapshot;
  toggle: (id: string) => void;
  add: (id: string) => void;
  quantity: (id: string, count: number) => void;
} | null>(null);
export function DemoProvider({ children }: { children: ReactNode }) {
  const state = useSyncExternalStore(
    subscribe,
    () => current,
    () => empty,
  );
  const [feedback, setFeedback] = useState({ text: "", sequence: 0 });
  function notify(text: string, saved: boolean) {
    setFeedback((previous) => ({
      sequence: previous.sequence + 1,
      text: `${text}${saved ? " Chỉ lưu trên thiết bị này." : " Bộ nhớ trình duyệt không khả dụng; chỉ lưu trong phiên này."}`,
    }));
  }
  return (
    <DemoContext.Provider
      value={{
        state,
        toggle(id) {
          const book = books.find((b) => b.id === id);
          if (!book) return;
          load(true);
          const exists = current.wishlist.includes(id);
          const saved = update({
            ...current,
            wishlist: exists
              ? current.wishlist.filter((x) => x !== id)
              : [...current.wishlist, id],
          });
          notify(
            `${exists ? "Đã bỏ yêu thích" : "Đã lưu yêu thích"}: ${book.title}.`,
            saved,
          );
        },
        add(id) {
          const book = books.find((b) => b.id === id);
          if (!book) return;
          load(true);
          const amount = Math.min((current.cart[id] || 0) + 1, 9);
          const saved = update({
            ...current,
            cart: { ...current.cart, [id]: amount },
          });
          notify(
            `${book.title}: ${amount} quyển trong giỏ thử nghiệm. Không tạo đơn hàng.`,
            saved,
          );
        },
        quantity(id, count) {
          const book = books.find((b) => b.id === id);
          if (!book || !Number.isInteger(count)) return;
          load(true);
          const cart = { ...current.cart };
          if (count <= 0) delete cart[id];
          else cart[id] = Math.min(count, 9);
          const saved = update({ ...current, cart });
          notify(
            count <= 0
              ? `Đã xóa ${book.title} khỏi giỏ thử nghiệm.`
              : `${book.title}: số lượng ${cart[id]} trong giỏ thử nghiệm.`,
            saved,
          );
        },
      }}
    >
      {children}
      <div
        className="live-feedback"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {feedback.text && <span key={feedback.sequence}>{feedback.text}</span>}
      </div>
    </DemoContext.Provider>
  );
}
export function useDemo() {
  const value = useContext(DemoContext);
  if (!value) throw new Error("DemoProvider required");
  return value;
}
export function WishlistButton({
  id,
  label,
  full = false,
  onRemoved,
}: {
  id: string;
  label: string;
  full?: boolean;
  onRemoved?: () => void;
}) {
  const { state, toggle } = useDemo();
  const selected = state.wishlist.includes(id);
  return (
    <button
      className={
        full ? "button button-secondary" : "icon-button wishlist-button"
      }
      aria-label={`${selected ? "Bỏ yêu thích" : "Yêu thích"}: ${label}`}
      aria-pressed={selected}
      onClick={() => {
        toggle(id);
        if (selected) onRemoved?.();
      }}
    >
      <Heart
        size={19}
        fill={selected ? "currentColor" : "none"}
        aria-hidden="true"
      />
      {full && (selected ? "Đã yêu thích" : "Lưu yêu thích")}
    </button>
  );
}
export function AddToCart({ id }: { id: string }) {
  const { add } = useDemo();
  return (
    <button className="button" onClick={() => add(id)}>
      <ShoppingBag size={18} aria-hidden="true" />
      Thêm vào giỏ thử nghiệm
    </button>
  );
}
export function DemoCollection({ mode }: { mode: "wishlist" | "cart" }) {
  const { state, quantity } = useDemo();
  const root = useRef<HTMLDivElement>(null);
  const selected = books.filter((b) =>
    mode === "wishlist"
      ? state.wishlist.includes(b.id)
      : Boolean(state.cart[b.id]),
  );
  function restoreFocus() {
    requestAnimationFrame(() => {
      root.current
        ?.querySelector<HTMLElement>(".collection-row button, .empty-state a")
        ?.focus();
    });
  }
  function changeQuantity(id: string, count: number) {
    quantity(id, count);
    if (count <= 0) restoreFocus();
  }
  return (
    <div ref={root}>
      <p className="notice">
        Dữ liệu chỉ lưu trên thiết bị này.{" "}
        {mode === "cart"
          ? "Giỏ thử nghiệm không giữ hàng, không tính tiền và không tạo đơn."
          : "Không đồng bộ tài khoản."}
      </p>
      {selected.length ? (
        <div className="collection-list">
          {selected.map((book) => (
            <article className="collection-row" key={book.id}>
              <Link
                href={`/products/${book.slug}`}
                className="mini-cover"
                aria-label={book.title}
              >
                <BookCover book={book} />
              </Link>
              <div>
                <p className="eyebrow">{book.edition}</p>
                <h2>
                  <Link href={`/products/${book.slug}`}>{book.title}</Link>
                </h2>
                <p>{book.author}</p>
                {mode === "wishlist" ? (
                  <AddToCart id={book.id} />
                ) : (
                  <div className="quantity">
                    <button
                      className="icon-button"
                      aria-label={`Giảm số lượng ${book.title}`}
                      onClick={() =>
                        changeQuantity(book.id, state.cart[book.id] - 1)
                      }
                    >
                      <Minus size={16} aria-hidden="true" />
                    </button>
                    <output
                      aria-live="polite"
                      aria-label={`Số lượng ${book.title}`}
                    >
                      {state.cart[book.id]}
                    </output>
                    <button
                      className="icon-button"
                      disabled={state.cart[book.id] >= 9}
                      aria-label={`Tăng số lượng ${book.title}`}
                      onClick={() =>
                        changeQuantity(book.id, state.cart[book.id] + 1)
                      }
                    >
                      <Plus size={16} aria-hidden="true" />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Xóa ${book.title}`}
                      onClick={() => changeQuantity(book.id, 0)}
                    >
                      <Trash2 size={17} aria-hidden="true" />
                    </button>
                  </div>
                )}
              </div>
              <WishlistButton
                id={book.id}
                label={book.title}
                onRemoved={mode === "wishlist" ? restoreFocus : undefined}
              />
            </article>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <ShoppingBag size={36} aria-hidden="true" />
          <h2>
            {mode === "cart"
              ? "Giỏ sách còn một khoảng trống"
              : "Cuốn sách yêu thích đầu tiên đang chờ bạn"}
          </h2>
          <p>Ghé qua kệ sách và tìm một câu chuyện cho riêng mình.</p>
          <Link className="button" href="/catalog">
            Khám phá kệ sách
          </Link>
        </div>
      )}
    </div>
  );
}
