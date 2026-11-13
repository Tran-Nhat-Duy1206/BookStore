import { it, expect } from "vitest";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { observeOutgoingHttp } from "../../experiments/next-security/outgoing-observer";

it("payload-blind counter actually observes Node fetch and HTTP, then unsubscribes", async () => {
  // Ephemeral plain HTTP proves observer MECHANICS only, never auth/TLS trust.
  const server = createServer((_req, res) => {
    res.setHeader("connection", "close");
    res.end("non-authorizing fixture");
  });
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Owned observer fixture unavailable.");
  const observer = observeOutgoingHttp(),
    url = `http://127.0.0.1:${address.port}/`;
  try {
    expect(observer.count).toBe(0);
    const result = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await result.arrayBuffer();
    await new Promise<void>((done, failed) => {
      const req = request(url, { agent: false, timeout: 2000 }, (res) => {
        res.resume();
        res.once("end", done);
        res.once("error", () =>
          failed(new Error("Owned observer response unavailable.")),
        );
      });
      req.once("error", () =>
        failed(new Error("Owned observer request unavailable.")),
      );
      req.once("timeout", () => req.destroy());
      req.end();
    });
    expect(observer.count >= 2).toBe(true);
    observer.close();
    const before = observer.count;
    const after = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await after.arrayBuffer();
    expect(observer.count === before).toBe(true);
    observer.close();
  } finally {
    observer.close();
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
