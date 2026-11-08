import type { Metadata } from "next";
import "@fontsource/lora/latin-400.css";
import "@fontsource/lora/vietnamese-400.css";
import "@fontsource/lora/latin-500.css";
import "@fontsource/lora/vietnamese-500.css";
import "@fontsource/be-vietnam-pro/latin-400.css";
import "@fontsource/be-vietnam-pro/vietnamese-400.css";
import "@fontsource/be-vietnam-pro/latin-500.css";
import "@fontsource/be-vietnam-pro/vietnamese-500.css";
import "./globals.css";
import { Header, Footer } from "@/components/shell";
import { DemoProvider } from "@/components/demo-state";
import { MotionProvider } from "@/components/motion";
import { site } from "@/config/site";

export const metadata: Metadata = {
  title: {
    default: `${site.name} — Một góc nhỏ, ngàn câu chuyện`,
    template: `%s | ${site.name}`,
  },
  description:
    "Không gian bookstore minh họa: khám phá sách hư cấu, bộ truyện và chuyện sau những trang sách. Chưa mở bán.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang={site.locale}>
      <body>
        <a className="skip-link" href="#main-content">
          Bỏ qua đến nội dung
        </a>
        <MotionProvider>
          <DemoProvider>
            <Header />
            <main id="main-content" tabIndex={-1}>
              {children}
            </main>
            <Footer />
          </DemoProvider>
        </MotionProvider>
      </body>
    </html>
  );
}
