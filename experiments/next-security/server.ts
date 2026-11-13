import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { observeOutgoingHttp } from "./outgoing-observer";
import { randomBytes } from "node:crypto";
import { createServer } from "node:https";
import { createSecureContext, TLSSocket } from "node:tls";
import type {
  IncomingMessage,
  OutgoingHttpHeaders,
  OutgoingHttpHeader,
  ServerResponse,
} from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import next from "next";
import type {
  NextSecurityConfig,
  NextSecurityHost,
  NextSecurityService,
  TrustedWire,
} from "./runtime/context";
import {
  bufferAndRestore,
  NEXT_AUTH_PATHS,
  NEXT_HOST,
  nextRawHeaders,
  SECURITY_PAGE,
  validActionBody,
  validateNextSecurityConfig,
} from "./wire";

const project = fileURLToPath(new URL("./", import.meta.url));
const HOST_KEY = Symbol.for("bookstore.isolated-next-security.host.v1");
const ownedLifetime = new AbortController();
const privateHeaders = {
  "cache-control": "private, no-store",
  pragma: "no-cache",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  connection: "close",
};
function reject(res: ServerResponse, status: number) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify({
    state: status >= 500 ? "unavailable" : "denied",
    applicationAdmission: "disabled",
  });
  res.writeHead(status, {
    ...privateHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
async function buildManifest() {
  const raw: unknown = JSON.parse(
    await readFile(
      resolve(project, ".next/server/server-reference-manifest.json"),
      "utf8",
    ),
  );
  if (
    !raw ||
    typeof raw !== "object" ||
    !("node" in raw) ||
    !raw.node ||
    typeof raw.node !== "object"
  )
    throw new Error("Isolated Action manifest unavailable.");
  const known = new Set<string>();
  const pages = new Set([
    "app/%5F_bookstore_next_security/page",
    "app/__bookstore_next_security/page",
    "/%5F_bookstore_next_security/page",
    "/__bookstore_next_security/page",
  ]);
  for (const [id, value] of Object.entries(raw.node)) {
    if (
      !/^[a-f0-9]{40,64}$/.test(id) ||
      !value ||
      typeof value !== "object" ||
      !("workers" in value) ||
      !value.workers ||
      typeof value.workers !== "object" ||
      Object.keys(value.workers).length !== 1 ||
      !Object.keys(value.workers).every((page) => pages.has(page))
    )
      throw new Error("Isolated Action owner unavailable.");
    known.add(id);
  }
  if (known.size !== 3) throw new Error("Isolated Action surface unavailable.");
  const assets = new Set<string>();
  async function walk(path: string, relative: string) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Isolated asset unavailable.");
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await walk(resolve(path, entry.name), nextRelative);
      else if (entry.isFile() && !entry.name.endsWith(".map"))
        assets.add(`/_next/static/${nextRelative}`);
      if (assets.size > 1024)
        throw new Error("Isolated asset surface unavailable.");
    }
  }
  await walk(resolve(project, ".next/static"), "");
  return { known, assets };
}
function ownResponseHeaders(
  res: ServerResponse,
  req: IncomingMessage,
  csp: string,
) {
  const original = res.writeHead;
  type Headers = OutgoingHttpHeaders | OutgoingHttpHeader[];
  const enforced = (input?: Headers): OutgoingHttpHeaders => {
    const headers: OutgoingHttpHeaders = {};
    if (Array.isArray(input))
      for (let i = 0; i < input.length; i += 2)
        headers[String(input[i])] = input[i + 1];
    else Object.assign(headers, input ?? {});
    for (const key of Object.keys(headers))
      if (
        ["cache-control", "content-security-policy", "connection"].includes(
          key.toLowerCase(),
        )
      )
        delete headers[key];
    return { ...headers, ...privateHeaders, "content-security-policy": csp };
  };
  res.writeHead = function (
    status: number,
    messageOrHeaders?: string | Headers,
    headers?: Headers,
  ) {
    if (
      (status >= 300 && status < 400) ||
      this.hasHeader("location") ||
      (req.method === "GET" && this.hasHeader("set-cookie"))
    ) {
      this.destroy();
      throw new Error("Isolated response policy denied.");
    }
    for (const [name, value] of Object.entries(privateHeaders))
      this.setHeader(name, value);
    this.setHeader("content-security-policy", csp);
    // Use Node's standard reason phrase; never reflect a supplied phrase.
    return original.call(
      this,
      status,
      enforced(
        typeof messageOrHeaders === "string" ? headers : messageOrHeaders,
      ),
    );
  };
}
/** Own process only. No raw provider/server-only React modules are imported here. */
export async function startIsolatedNextSecurity(value: NextSecurityConfig) {
  ownedLifetime.signal.throwIfAborted();
  const config = validateNextSecurityConfig(value);
  process.stdout.write("BookStore Next startup config validated.\n");
  if (Object.getOwnPropertyDescriptor(globalThis, HOST_KEY))
    throw new Error("Isolated host already initialized.");
  const manifest = await buildManifest();
  process.stdout.write("BookStore Next startup manifest validated.\n");
  const requests = new AsyncLocalStorage<TrustedWire>();
  let published: NextSecurityService | null = null;
  let servicePublications = 0,
    ingressRequests = 0,
    tlsErrors = 0;
  const outgoing = observeOutgoingHttp();
  const stopObserving = () => outgoing.close();
  const host: NextSecurityHost = Object.freeze({
    config,
    requests,
    get service() {
      return published;
    },
    publish(service: NextSecurityService) {
      if (
        published ||
        !service ||
        typeof service.forRequest !== "function" ||
        typeof service.close !== "function" ||
        typeof service.cancelUndelivered !== "function"
      )
        throw new Error("Isolated service publication rejected.");
      published = service;
      servicePublications++;
      process.stdout.write("BookStore Next startup service published.\n");
    },
  });
  Object.defineProperty(globalThis, HOST_KEY, {
    value: host,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  const origin = new URL(config.origin),
    port = Number(origin.port);
  const secure = createSecureContext({ ...config.tls, minVersion: "TLSv1.3" });
  let closing = false,
    inflight = 0,
    localUsed = 0,
    window = performance.now();
  const sockets = new WeakSet<object>(),
    cleanup = new Set<Promise<unknown>>();
  const server = createServer({
    key: config.tls.key,
    cert: config.tls.cert,
    minVersion: "TLSv1.3",
    maxHeaderSize: 8192,
    handshakeTimeout: 3000,
    headersTimeout: 3000,
    requestTimeout: 5000,
    keepAliveTimeout: 1000,
    connectionsCheckingInterval: 1000,
    insecureHTTPParser: false,
    SNICallback(name, callback) {
      if (name !== NEXT_HOST) callback(new Error("Unavailable"));
      else callback(null, secure);
    },
  });
  const app = next({
    dir: project,
    dev: false,
    hostname: NEXT_HOST,
    port,
    quiet: true,
    httpServer: server,
  });
  try {
    // Await canonical construction BEFORE the native Next constructor starts
    // background prepare/preload. No construction retry or clock relaxation.
    // Use our OWN compiled hook, not a fake request or raw provider import.
    const hook: unknown = createRequire(import.meta.url)(
      resolve(project, ".next/server/instrumentation.js"),
    );
    if (
      !hook ||
      typeof hook !== "object" ||
      !("register" in hook) ||
      typeof hook.register !== "function"
    )
      throw new Error("Isolated compiled hook unavailable.");
    await hook.register();
    if (!host.service)
      throw new Error("Isolated compiled instrumentation did not initialize.");
    ownedLifetime.signal.throwIfAborted();
    process.stdout.write("BookStore Next startup preparing framework.\n");
    await app.prepare();
    process.stdout.write("BookStore Next startup framework prepared.\n");
    ownedLifetime.signal.throwIfAborted();
    const handle = app.getRequestHandler();
    const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
      ingressRequests = Math.min(1000000, ingressRequests + 1);
      const headers = nextRawHeaders(req),
        socket = req.socket;
      if (
        closing ||
        !(socket instanceof TLSSocket) ||
        !socket.encrypted ||
        socket.localAddress !== "127.0.0.1" ||
        socket.remoteAddress !== "127.0.0.1" ||
        socket.localPort !== port ||
        socket.servername !== NEXT_HOST ||
        req.httpVersion !== "1.1" ||
        !headers ||
        headers.get("host") !== origin.host
      ) {
        reject(res, 403);
        return;
      }
      if (sockets.has(socket)) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      const target = req.url ?? "";
      const page =
        target === SECURITY_PAGE ||
        new RegExp(`^${SECURITY_PAGE}\\?_rsc=[a-zA-Z0-9_-]{1,64}$`).test(
          target,
        );
      const auth = Object.values(NEXT_AUTH_PATHS).some(
        (path) => path === target,
      );
      const asset = manifest.assets.has(target);
      if (!page && !auth && !asset) {
        reject(res, 404);
        return;
      }
      if (
        (auth && req.method !== "POST") ||
        (asset && req.method !== "GET") ||
        (page && req.method !== "GET" && req.method !== "POST")
      ) {
        reject(res, 405);
        return;
      }
      if (
        (req.method === "POST" &&
          (headers.get("origin") !== config.origin ||
            (headers.has("sec-fetch-site") &&
              headers.get("sec-fetch-site") !== "same-origin"))) ||
        (headers.has("origin") && headers.get("origin") !== config.origin)
      ) {
        reject(res, 403);
        return;
      }
      if (
        auth &&
        (headers.get("x-bookstore-csrf") !== "1" ||
          !["application/json", "application/json; charset=utf-8"].includes(
            headers.get("content-type") ?? "",
          ))
      ) {
        reject(res, headers.get("x-bookstore-csrf") !== "1" ? 403 : 415);
        return;
      }
      if (
        headers.has("next-action") &&
        (!page ||
          req.method !== "POST" ||
          !manifest.known.has(headers.get("next-action")!))
      ) {
        reject(res, 403);
        return;
      }
      const lengthText = headers.get("content-length");
      if (
        req.method === "POST" &&
        (!lengthText || !/^(0|[1-9][0-9]{0,3})$/.test(lengthText))
      ) {
        reject(res, 411);
        return;
      }
      if (
        req.method === "GET" &&
        lengthText !== undefined &&
        lengthText !== "0"
      ) {
        reject(res, 400);
        return;
      }
      const length = Number(lengthText ?? 0);
      if (
        length > (auth ? 1024 : 8192) ||
        (headers.get("cookie")?.length ?? 0) > 4096
      ) {
        reject(res, 413);
        return;
      }
      const now = performance.now();
      if (now - window >= 60000) {
        window = now;
        localUsed = 0;
      }
      if (inflight >= 16 || ++localUsed > 256) {
        reject(res, 503);
        return;
      }
      inflight++;
      let pending: string | null = null;
      const discard = () => {
        if (pending && host.service) {
          const work = host.service.cancelUndelivered(pending);
          cleanup.add(work);
          void work.finally(() => cleanup.delete(work));
        }
        pending = null;
      };
      res.once("finish", () => {
        pending = null;
      });
      res.once("close", () => {
        if (!res.writableFinished) discard();
      });
      const absolute = setTimeout(() => {
        req.destroy();
        res.destroy();
      }, 10000);
      let bodyDeadline: ReturnType<typeof setTimeout> | undefined;
      let bodyDone: (() => void) | undefined;
      try {
        req.setTimeout(3000, () => req.destroy());
        res.setTimeout(10000, () => res.destroy());
        bodyDeadline = setTimeout(() => req.destroy(), 3000);
        let body: Buffer = Buffer.alloc(0);
        if (auth) {
          // Next's Route adapter passes the ORIGINAL Node stream to Undici.
          // Do not disturb it: framing/cap are already checked, then the Route
          // consumes exact bytes and checks completion/schema BEFORE authority.
          bodyDone = () => {
            if (bodyDeadline) clearTimeout(bodyDeadline);
            bodyDeadline = undefined;
          };
          req.once("end", bodyDone);
        } else {
          body = await bufferAndRestore(req, length);
          clearTimeout(bodyDeadline);
          bodyDeadline = undefined;
        }
        if (
          page &&
          req.method === "POST" &&
          !(await validActionBody(
            body,
            headers.get("content-type") ?? "",
            headers.get("next-action"),
            manifest.known,
          ))
        ) {
          reject(res, 400);
          return;
        }
        const nonce = randomBytes(16).toString("base64");
        const csp = `default-src 'none'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
        ownResponseHeaders(res, req, csp);
        // Generated ONLY here after raw supplied headers have been rejected.
        req.headers["content-security-policy"] = csp;
        const wire: TrustedWire = Object.freeze({
          path: page ? SECURITY_PAGE : target,
          method: req.method!,
          origin: config.origin,
          cookie: headers.get("cookie") ?? "",
          contentLength: length,
          complete: () => req.complete && !req.aborted,
          aborted: () => req.aborted || res.destroyed || closing,
          stageCookie(cookie: string) {
            if (pending)
              throw new Error("Isolated response credential already staged.");
            pending = cookie;
          },
        });
        await requests.run(wire, () => handle(req, res));
      } catch {
        discard();
        reject(res, 503);
      } finally {
        clearTimeout(absolute);
        if (bodyDeadline) clearTimeout(bodyDeadline);
        if (bodyDone) req.removeListener("end", bodyDone);
        inflight--;
      }
    };
    server.on("request", (req, res) => {
      void dispatch(req, res).catch(() => reject(res, 503));
    });
    server.maxConnections = 32;
    server.maxHeadersCount = 48;
    server.maxRequestsPerSocket = 1;
    server.on("checkContinue", (_req, res) => reject(res, 417));
    server.on("checkExpectation", (_req, res) => reject(res, 417));
    server.on("upgrade", (_req, socket) => socket.destroy());
    server.on("tlsClientError", () => {
      tlsErrors = Math.min(1000000, tlsErrors + 1);
    });
    server.on("clientError", (_error, socket) => {
      const body = '{"state":"denied","applicationAdmission":"disabled"}';
      if (socket.writable)
        socket.end(
          `HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nCache-Control: private, no-store\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
      else socket.destroy();
    });
    await new Promise<void>((resolveListen, rejectListen) => {
      const cleanupListen = () => {
        server.removeListener("error", failed);
        ownedLifetime.signal.removeEventListener("abort", failed);
      };
      const failed = () => {
        cleanupListen();
        rejectListen(new Error("Isolated listener unavailable."));
      };
      server.once("error", failed);
      ownedLifetime.signal.addEventListener("abort", failed, { once: true });
      server.listen(
        {
          host: "127.0.0.1",
          port,
          exclusive: true,
          signal: ownedLifetime.signal,
        },
        () => {
          cleanupListen();
          resolveListen();
        },
      );
    });
    server.on("error", () => {
      closing = true;
    });
    let closePromise: Promise<void> | undefined;
    return Object.freeze({
      origin: config.origin,
      diagnostics: () =>
        Object.freeze({
          v: 1,
          servicePublications,
          outgoingHttpRequests: outgoing.count,
          ingressRequests,
          tlsErrors,
        }),
      close() {
        return (closePromise ??= (async () => {
          closing = true;
          await new Promise<void>((done) => server.close(() => done()));
          try {
            await Promise.allSettled([...cleanup]);
            await host.service?.close();
            await app.close();
          } finally {
            stopObserving();
          }
        })());
      },
    });
  } catch {
    stopObserving();
    if (server.listening)
      await new Promise<void>((done) => server.close(() => done()));
    await host.service?.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    throw new Error("Isolated Next security startup unavailable.");
  }
}
export type IsolatedNextSecurity = Awaited<
  ReturnType<typeof startIsolatedNextSecurity>
>;
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  let transport: IsolatedNextSecurity | undefined,
    closed = false,
    closeRequested = false;
  const close = async () => {
    closeRequested = true;
    ownedLifetime.abort();
    if (!transport || closed) return;
    closed = true;
    await transport.close();
    process.exitCode = 0;
    if (process.connected) process.disconnect?.();
  };
  // Install BEFORE startup, not only after credentials/listener are ready.
  process.once("disconnect", () => {
    void close();
  });
  process.once("SIGTERM", () => {
    void close();
  });
  process.once("SIGINT", () => {
    void close();
  });
  void (async () => {
    const raw: unknown = JSON.parse(
      process.env.BOOKSTORE_NEXT_SECURITY_CONFIG ?? "null",
    );
    transport = await startIsolatedNextSecurity(
      validateNextSecurityConfig(raw),
    );
    if (closeRequested) {
      await close();
      return;
    }
    process.stdout.write("BookStore isolated Next security ready.\n");
    process.on("message", (message) => {
      if (
        !message ||
        typeof message !== "object" ||
        Object.keys(message).join(",") !== "operation" ||
        !("operation" in message)
      )
        return;
      if (message.operation === "close") void close();
      else if (message.operation === "diagnostics" && process.connected)
        process.send?.(transport?.diagnostics());
    });
  })().catch(() => {
    if (!closeRequested)
      console.error(
        "Isolated Next security process unavailable; details suppressed.",
      );
    process.exitCode = closeRequested ? 0 : 1;
    if (process.connected) process.disconnect?.();
  });
}
