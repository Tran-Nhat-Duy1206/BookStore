"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Minus, Plus, ShoppingBag, Trash2, X } from "lucide-react";
import { useDemo } from "./demo-state";

export function CartDrawer() {
  const { books, state, quantity } = useDemo();
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const pendingRemovalIndex = useRef<number | null>(null);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (!open) {
      pendingRemovalIndex.current = null;
      return;
    }
    if (pendingRemovalIndex.current === null) return;

    // Wait until the deleted row has left the committed DOM before restoring focus.
    const frame = requestAnimationFrame(() => {
      const index = pendingRemovalIndex.current;
      pendingRemovalIndex.current = null;
      const panel = panelRef.current;
      if (!panel || index === null) return;
      const remaining = panel.querySelectorAll<HTMLButtonElement>(
        "button[data-cart-remove]",
      );
      const target =
        remaining[Math.min(index, remaining.length - 1)] ??
        panel.querySelector<HTMLAnchorElement>("a[data-cart-empty]") ??
        panel.querySelector<HTMLAnchorElement>("a[data-cart-page]");
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [state.cart, open]);
  const count = Object.values(state.cart).reduce(
    (sum, amount) => sum + amount,
    0,
  );
  const selected = books.filter((book) => (state.cart[book.id] ?? 0) > 0);
  const transition = { duration: reducedMotion ? 0 : 0.22 };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="icon-button"
          aria-label={`Mở giỏ thử nghiệm (${count})`}
        >
          <ShoppingBag size={21} aria-hidden="true" />
          <span className="count" aria-hidden="true">
            {count}
          </span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal forceMount>
        <AnimatePresence>
          {open && (
            <Dialog.Overlay key="cart-overlay" forceMount asChild>
              <motion.div
                className="drawer-overlay"
                initial={{ opacity: reducedMotion ? 1 : 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={transition}
              />
            </Dialog.Overlay>
          )}
          {open && (
            <Dialog.Content key="cart-panel" forceMount asChild>
              <motion.div
                ref={panelRef}
                className="mobile-drawer"
                initial={{
                  x: reducedMotion ? 0 : "100%",
                  opacity: reducedMotion ? 1 : 0,
                }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: reducedMotion ? 0 : "100%", opacity: 0 }}
                transition={transition}
              >
                <div className="drawer-heading">
                  <Dialog.Title>Giỏ thử nghiệm</Dialog.Title>
                  <Dialog.Close asChild>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label="Đóng giỏ thử nghiệm"
                    >
                      <X size={21} aria-hidden="true" />
                    </button>
                  </Dialog.Close>
                </div>
                <Dialog.Description className="notice">
                  Chỉ thử chọn sách trên thiết bị này. Không giữ hàng, không
                  tính tiền, không thanh toán và không tạo đơn hàng.
                </Dialog.Description>
                {selected.length ? (
                  <ul
                    className="my-6 list-none space-y-6 p-0"
                    aria-label="Sách trong giỏ thử nghiệm"
                  >
                    {selected.map((book, index) => {
                      const amount = state.cart[book.id];
                      return (
                        <li
                          key={book.id}
                          className="space-y-2 border-b border-[var(--border)] pb-4"
                        >
                          <h3>
                            <Link
                              href={`/products/${book.slug}`}
                              onClick={() => setOpen(false)}
                            >
                              {book.title}
                            </Link>
                          </h3>
                          <p>{book.author}</p>
                          <div
                            className="quantity"
                            role="group"
                            aria-label={`Điều chỉnh số lượng ${book.title}`}
                          >
                            <button
                              type="button"
                              className="icon-button"
                              disabled={amount <= 1}
                              aria-label={`Giảm số lượng ${book.title}`}
                              onClick={() => quantity(book.id, amount - 1)}
                            >
                              <Minus size={17} aria-hidden="true" />
                            </button>
                            <output
                              aria-live="polite"
                              aria-label={`Số lượng ${book.title}`}
                            >
                              {amount}
                            </output>
                            <button
                              type="button"
                              className="icon-button"
                              disabled={amount >= 9}
                              aria-label={`Tăng số lượng ${book.title}`}
                              onClick={() => quantity(book.id, amount + 1)}
                            >
                              <Plus size={17} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="icon-button"
                              data-cart-remove
                              aria-label={`Xóa ${book.title} khỏi giỏ thử nghiệm`}
                              onClick={() => {
                                pendingRemovalIndex.current = index;
                                quantity(book.id, 0);
                              }}
                            >
                              <Trash2 size={17} aria-hidden="true" />
                            </button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <div className="my-6 space-y-4">
                    <p>
                      Giỏ sách còn một khoảng trống. Ghé kệ sách để chọn một câu
                      chuyện cho riêng mình.
                    </p>
                    <Link
                      className="text-link"
                      data-cart-empty
                      href="/catalog"
                      onClick={() => setOpen(false)}
                    >
                      Khám phá kệ sách
                    </Link>
                  </div>
                )}
                <Link
                  className="button"
                  data-cart-page
                  href="/cart"
                  onClick={() => setOpen(false)}
                >
                  Xem giỏ thử nghiệm
                </Link>
              </motion.div>
            </Dialog.Content>
          )}
        </AnimatePresence>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
