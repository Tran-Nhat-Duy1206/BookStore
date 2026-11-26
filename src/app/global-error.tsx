"use client";

export default function GlobalError() {
  return (
    <html lang="vi">
      <head>
        <title>Tạm thời chưa thể tải trang</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head>
      <body>
        <style>{`
          body { margin: 0; background: #f5efe5; color: #30231a; font: 1rem/1.6 system-ui, sans-serif; }
          .recovery { box-sizing: border-box; max-width: 38rem; margin: 0 auto; padding: clamp(1.25rem, 6vw, 4rem); overflow-wrap: anywhere; }
          .recovery h1 { font: 500 clamp(1.75rem, 6vw, 2.5rem)/1.2 Georgia, serif; }
          .recovery a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 1rem; border-radius: .25rem; background: #694028; color: #fffaf4; text-decoration: underline; }
          .recovery a:focus-visible { outline: 3px solid #694028; outline-offset: 4px; }
        `}</style>
        <main className="recovery">
          <p>Mộc &amp; Mực</p>
          <h1>Tạm thời chưa thể tải trang</h1>
          <p>
            Nhà sách đang gặp sự cố khi tải dữ liệu. Bạn có thể thử tải lại
            trang.
          </p>
          {/* A native document navigation repeats the same URL without hydration. */}
          <a href="">Thử lại</a>
        </main>
      </body>
    </html>
  );
}
