import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import next from "next";

// Owned NEGATIVE fixture: the ordinary root application, not the isolated app.
const root = fileURLToPath(new URL("../", import.meta.url));
void (async () => {
  const mode = process.env.BOOKSTORE_ORDINARY_MODE;
  if (
    !["development", "production"].includes(mode ?? "") ||
    process.env.DATA_SOURCE !== "fixture" ||
    process.env.NODE_ENV !== mode
  )
    throw new Error();
  const app = next({
    dir: root,
    dev: mode === "development",
    hostname: "127.0.0.1",
    port: 3106,
    quiet: true,
  });
  await app.prepare();
  if (process.send && !process.connected) {
    await app.close();
    return;
  }
  const handle = app.getRequestHandler();
  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(503, { "cache-control": "private, no-store" });
        res.end("Unavailable");
      } else res.destroy();
    });
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 1000;
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await app.close();
    if (process.connected) process.disconnect?.();
    process.exit(0);
  };
  process.once("disconnect", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  if (process.send && !process.connected) {
    await close();
    return;
  }
  await new Promise<void>((done, failed) => {
    server.once("error", () => failed(new Error()));
    server.listen({ host: "127.0.0.1", port: 3106, exclusive: true }, () =>
      done(),
    );
  });
  if (closing) return;
  process.stdout.write("BookStore ordinary negative fixture ready.\n");
  process.on("message", (message) => {
    if (
      message &&
      typeof message === "object" &&
      Object.keys(message).join(",") === "operation" &&
      "operation" in message &&
      message.operation === "close"
    )
      void close().catch(() => {
        process.exitCode = 1;
      });
  });
})().catch(() => {
  console.error(
    "Owned ordinary Next negative fixture unavailable; details suppressed.",
  );
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
