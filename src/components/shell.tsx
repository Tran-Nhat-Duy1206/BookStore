"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { BookOpen, Search, Menu, X, Heart, ArrowUpRight } from "lucide-react";
import { site } from "@/config/site";
import { useDemo } from "./demo-state";
import { CartDrawer } from "./cart-drawer";

const links = [
  { href: "/catalog", label: "Kệ sách" },
  { href: "/catalog?category=manga", label: "Manga & truyện tranh" },
  { href: "/releases", label: "Lịch phát hành" },
  { href: "/news", label: "Chuyện tiệm sách" },
];
function SearchForm({ close }: { close?: () => void }) {
  return (
    <form
      action="/catalog"
      className="search-form"
      role="search"
      onSubmit={close}
    >
      <Search size={18} aria-hidden="true" />
      <input
        name="q"
        type="search"
        aria-label="Tìm tên sách, tác giả"
        placeholder="Tìm một câu chuyện…"
      />
      <button className="icon-button" aria-label="Tìm kiếm" type="submit">
        <ArrowUpRight size={18} aria-hidden="true" />
      </button>
    </form>
  );
}
export function Header() {
  const pathname = usePathname();
  const { state } = useDemo();
  const [open, setOpen] = useState(false);
  const reduced = useReducedMotion();
  return (
    <>
      <div className="demo-banner">
        KHÔNG GIAN THỬ NGHIỆM{" "}
        <span>
          — Sách, lịch phát hành và nội dung đều là minh họa. Chưa mở bán.
        </span>
      </div>
      <header className="site-header">
        <div className="header-main container">
          <Link
            className="brand"
            href="/"
            aria-label={`${site.name} — Trang chủ`}
          >
            <BookOpen size={33} strokeWidth={1.3} aria-hidden="true" />
            <span>
              {site.name}
              <small>MỘT GÓC NHỎ, NGÀN CÂU CHUYỆN</small>
            </span>
          </Link>
          <div className="desktop-search">
            <SearchForm />
          </div>
          <div className="header-actions">
            <Link
              className="icon-button"
              href="/wishlist"
              aria-label={`Sách yêu thích (${state.wishlist.length})`}
            >
              <Heart size={21} aria-hidden="true" />
              <span className="count">{state.wishlist.length}</span>
            </Link>
            <CartDrawer />
            <Dialog.Root open={open} onOpenChange={setOpen}>
              <Dialog.Trigger
                className="icon-button mobile-menu"
                aria-label="Mở menu"
              >
                <Menu aria-hidden="true" />
              </Dialog.Trigger>
              <AnimatePresence>
                {open && (
                  <Dialog.Portal forceMount>
                    <Dialog.Overlay forceMount asChild>
                      <motion.div
                        className="drawer-overlay"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                      />
                    </Dialog.Overlay>
                    <Dialog.Content forceMount asChild>
                      <motion.div
                        className="mobile-drawer"
                        initial={{ x: reduced ? 0 : "100%" }}
                        animate={{ x: 0 }}
                        exit={{ x: reduced ? 0 : "100%", opacity: 0 }}
                        transition={{ duration: reduced ? 0 : 0.28 }}
                      >
                        <div className="drawer-heading">
                          <Dialog.Title>{site.name}</Dialog.Title>
                          <Dialog.Close
                            className="icon-button"
                            aria-label="Đóng menu"
                          >
                            <X aria-hidden="true" />
                          </Dialog.Close>
                        </div>
                        <Dialog.Description>
                          Khám phá không gian sách minh họa. Chưa nhận đơn hàng.
                        </Dialog.Description>
                        <SearchForm close={() => setOpen(false)} />
                        <nav aria-label="Điều hướng di động">
                          {links.map((link) => (
                            <Link
                              key={link.href}
                              href={link.href}
                              onClick={() => setOpen(false)}
                            >
                              {link.label}
                              <ArrowUpRight size={18} aria-hidden="true" />
                            </Link>
                          ))}
                        </nav>
                        <p className="demo-caption">
                          Thương hiệu tạm thời · Không có địa chỉ cửa hàng
                        </p>
                      </motion.div>
                    </Dialog.Content>
                  </Dialog.Portal>
                )}
              </AnimatePresence>
            </Dialog.Root>
          </div>
        </div>
        <div className="nav-row">
          <nav className="container desktop-nav" aria-label="Điều hướng chính">
            {links.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                aria-current={pathname === link.href ? "page" : undefined}
              >
                {link.label}
              </Link>
            ))}
            <span className="nav-note">
              Đọc chậm một chút. Khám phá nhiều hơn.
            </span>
          </nav>
        </div>
        <div className="mobile-search container">
          <SearchForm />
        </div>
      </header>
    </>
  );
}
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div>
          <Link className="brand" href="/">
            <BookOpen size={30} aria-hidden="true" />
            <span>{site.name}</span>
          </Link>
          <p>
            Một khoảng lặng dành cho những trang sách.
            <br />
            Một dự án bookstore đang được vun trồng.
          </p>
        </div>
        <div>
          <h2>Ghé thăm</h2>
          <Link href="/catalog">Kệ sách minh họa</Link>
          <Link href="/releases">Lịch phát hành mẫu</Link>
          <Link href="/news">Chuyện tiệm sách</Link>
        </div>
        <div>
          <h2>Góc của bạn</h2>
          <Link href="/wishlist">Sách yêu thích</Link>
          <Link href="/cart">Giỏ thử nghiệm</Link>
          <p>
            Không tài khoản. Không thanh toán.
            <br />
            Dữ liệu chỉ lưu trên thiết bị.
          </p>
        </div>
      </div>
      <div className="container footer-bottom">
        <span>
          {site.name} là tên tạm thời. Toàn bộ sách và nội dung là hư cấu.
        </span>
        <span>Được làm với sự trân trọng từng trang sách.</span>
      </div>
    </footer>
  );
}
