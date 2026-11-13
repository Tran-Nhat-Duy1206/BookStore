import { describe, expect, it } from "vitest";
import { createServer, IncomingMessage } from "node:http";
import {
  bufferAndRestore,
  nextRawHeaders,
  validActionBody,
} from "../../experiments/next-security/wire";
import { createConnection, Socket } from "node:net";
import { once } from "node:events";
import { Readable } from "node:stream";

/** Local HTTP tests ONLY Readable mechanics, never authentication or TLS trust. */
async function withBodyFixture<T>(
  receive: (request: IncomingMessage) => Promise<T>,
  send: (socket: Socket) => Promise<void>,
): Promise<T> {
  const sockets = new Set<Socket>();
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // The rejection is observed immediately even when the writer is still finishing.
  void result.catch(() => undefined);
  const server = createServer((request, response) => {
    request.on("error", () => undefined);
    void receive(request).then(
      (value) => {
        response.end("fixture-complete");
        resolveResult(value);
      },
      (error) => {
        response.destroy();
        rejectResult(error);
      },
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true });
  await once(server, "listening");
  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== "127.0.0.1"
  )
    throw new Error("Body fixture bind rejected.");
  const client = createConnection({ host: "127.0.0.1", port: address.port });
  client.on("error", () => undefined);
  client.resume();
  let expire!: () => void;
  const deadline = new Promise<never>((_resolve, reject) => {
    expire = () => reject(new Error("Body fixture deadline exceeded."));
  });
  void deadline.catch(() => undefined);
  const timer = setTimeout(expire, 2000);
  try {
    await Promise.race([once(client, "connect"), deadline]);
    client.setNoDelay(true);
    await Promise.race([send(client), deadline]);
    return await Promise.race([result, deadline]);
  } finally {
    clearTimeout(timer);
    client.destroy();
    // Only sockets accepted by THIS ephemeral fixture are closed.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
function head(length: number): string {
  return `POST /body-mechanics HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${length}\r\nConnection: close\r\n\r\n`;
}
function write(socket: Socket, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) =>
    socket.write(data, (error) => (error ? reject(error) : resolve())),
  );
}

async function replay(
  request: IncomingMessage,
  length: number,
  mode: "iterator" | "web",
  expected: Buffer,
  sensitiveStep: () => void = () => undefined,
) {
  // This is a TEST sentinel only, not a substitute for service.viable().
  let sensitiveInvocations = 0;
  const original = request;
  const socket = request.socket;
  const rawHeaders = [...request.rawHeaders];
  const body = await bufferAndRestore(request, length);
  const beforeEnd = !request.readableEnded;
  // Parser completeness before the Next-like decoder is observed, not required:
  // the selected boundary is complete BEFORE any sensitive operation.
  const completeBeforeConsume = request.complete;
  const sensitiveBeforeConsume = sensitiveInvocations;
  let restored: Buffer;
  if (mode === "web") {
    // Node and DOM stream declarations differ, but this is the actual public adapter.
    const stream = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    restored = Buffer.from(await new Response(stream).arrayBuffer());
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    restored = Buffer.concat(chunks);
  }
  const completeBeforeSensitiveStep = request.complete;
  if (
    !completeBeforeSensitiveStep ||
    request.aborted ||
    !restored.equals(expected)
  )
    throw new Error("Sensitive fixture step denied.");
  sensitiveInvocations++;
  sensitiveStep();
  return {
    identical: request === original && request.socket === socket,
    headersIntact:
      JSON.stringify(request.rawHeaders) === JSON.stringify(rawHeaders),
    bodyExact: body.equals(expected),
    replayExact: restored.equals(expected),
    beforeEnd,
    completeBeforeConsume,
    complete: request.complete,
    ended: request.readableEnded,
    sensitiveBeforeConsume,
    completeBeforeSensitiveStep,
    sensitiveInvocations,
  };
}
function expectExactOrderedReplay(
  observed: Awaited<ReturnType<typeof replay>>,
) {
  expect(observed).toEqual({
    identical: true,
    headersIntact: true,
    bodyExact: true,
    replayExact: true,
    beforeEnd: true,
    completeBeforeConsume: expect.any(Boolean),
    complete: true,
    ended: true,
    sensitiveBeforeConsume: 0,
    completeBeforeSensitiveStep: true,
    sensitiveInvocations: 1,
  });
}

describe("native Node Request constructor compatibility (HTTP mechanics only)", () => {
  const body = Buffer.from("public-fixture");
  function nativeRequest(request: IncomingMessage): Request {
    // Node accepts AsyncIterable IncomingMessage bodies with duplex=half. The DOM
    // RequestInit declaration lacks this Node extension; no stream conversion here.
    const init: RequestInit & { duplex: "half" } = {
      method: "POST",
      body: request as unknown as BodyInit,
      duplex: "half",
    };
    return new Request("https://fixture.invalid/body-mechanics", init);
  }
  it("rejects the disturbed original IncomingMessage after bufferAndRestore despite exact restored bytes", async () => {
    const observed = await withBodyFixture(
      async (request) => {
        let sensitiveInvocations = 0;
        const buffered = await bufferAndRestore(request, body.length);
        const disturbed = Readable.isDisturbed(request);
        let rejected = false;
        let typeError = false;
        try {
          nativeRequest(request);
          sensitiveInvocations++;
        } catch (error) {
          rejected = true;
          typeError = error instanceof TypeError;
        }
        return {
          bufferedExact: buffered.equals(body),
          disturbed,
          rejected,
          typeError,
          sensitiveInvocations,
        };
      },
      async (socket) => {
        await write(socket, head(body.length));
        await write(socket, body);
      },
    );
    expect(observed).toEqual({
      bufferedExact: true,
      disturbed: true,
      rejected: true,
      typeError: true,
      sensitiveInvocations: 0,
    });
  });
  it("consumes an UNREAD original IncomingMessage exactly and completes before the sensitive sentinel", async () => {
    const observed = await withBodyFixture(
      async (request) => {
        const original = request;
        const socket = request.socket;
        const rawHeaders = [...request.rawHeaders];
        let sensitiveInvocations = 0;
        const disturbedBefore = Readable.isDisturbed(request);
        const nextLike = nativeRequest(request);
        const sensitiveBeforeConsume = sensitiveInvocations;
        const received = Buffer.from(await nextLike.arrayBuffer());
        const completeBeforeSensitiveStep = request.complete;
        if (
          !completeBeforeSensitiveStep ||
          request.aborted ||
          !received.equals(body)
        )
          throw new Error("Native Request fixture step denied.");
        sensitiveInvocations++;
        return {
          disturbedBefore,
          sensitiveBeforeConsume,
          completeBeforeSensitiveStep,
          sensitiveInvocations,
          bodyExact: received.equals(body),
          identical: request === original && request.socket === socket,
          headersIntact:
            JSON.stringify(request.rawHeaders) === JSON.stringify(rawHeaders),
        };
      },
      async (socket) => {
        await write(socket, head(body.length));
        await write(socket, body);
      },
    );
    expect(observed).toEqual({
      disturbedBefore: false,
      sensitiveBeforeConsume: 0,
      completeBeforeSensitiveStep: true,
      sensitiveInvocations: 1,
      bodyExact: true,
      identical: true,
      headersIntact: true,
    });
  });
});

describe("original IncomingMessage bounded body restoration (HTTP mechanics only)", () => {
  for (const mode of ["iterator", "web"] as const) {
    for (const length of [0, 1, 1024, 8192]) {
      it(`restores exactly ${length} fixture bytes through ${mode} without changing request/socket/headers`, async () => {
        const body = Buffer.alloc(length, 65);
        const observed = await withBodyFixture(
          (request) => replay(request, length, mode, body),
          async (socket) => {
            await write(socket, head(length));
            if (length) await write(socket, body);
          },
        );
        expectExactOrderedReplay(observed);
      });
    }
    it(`restores fragmented bytes with a confirmed first readable event through ${mode}`, async () => {
      let firstReadable!: () => void;
      const first = new Promise<void>((resolve) => {
        firstReadable = resolve;
      });
      const body = Buffer.from("fragment-one|fragment-two|fragment-three");
      let sensitiveInvocations = 0;
      const observed = await withBodyFixture(
        (request) => {
          request.once("readable", firstReadable);
          return replay(request, body.length, mode, body, () => {
            sensitiveInvocations++;
          });
        },
        async (socket) => {
          await write(
            socket,
            head(body.length) + body.subarray(0, 5).toString(),
          );
          await first;
          expect(sensitiveInvocations).toBe(0);
          await write(socket, body.subarray(5, 17));
          await write(socket, body.subarray(17));
        },
      );
      expectExactOrderedReplay(observed);
      expect(sensitiveInvocations).toBe(1);
    });
  }

  for (const mode of ["iterator", "web"] as const) {
    for (const failure of ["truncated", "aborted", "deadline"] as const) {
      it(`never invokes the sensitive sentinel on ${failure} through ${mode}`, async () => {
        let sensitiveInvocations = 0;
        let firstReadable!: () => void;
        const first = new Promise<void>((resolve) => {
          firstReadable = resolve;
        });
        const rejected = await withBodyFixture(
          async (request) => {
            request.once("readable", firstReadable);
            const timer =
              failure === "deadline"
                ? setTimeout(() => request.destroy(), 30)
                : undefined;
            try {
              await replay(request, 20, mode, Buffer.alloc(20, 65), () => {
                sensitiveInvocations++;
              });
              return false;
            } catch {
              return true;
            } finally {
              if (timer) clearTimeout(timer);
            }
          },
          async (socket) => {
            await write(
              socket,
              head(20) + (failure === "deadline" ? "" : "short"),
            );
            if (failure === "truncated") socket.end();
            if (failure === "aborted") {
              await first;
              expect(sensitiveInvocations).toBe(0);
              socket.destroy();
            }
          },
        );
        expect(rejected).toBe(true);
        expect(sensitiveInvocations).toBe(0);
      });
    }
  }

  it("rejects bytes above the 8192 bound and removes its listeners", async () => {
    const observed = await withBodyFixture(
      async (request) => {
        const baseline = [
          request.listenerCount("readable"),
          request.listenerCount("end"),
          request.listenerCount("aborted"),
          request.listenerCount("error"),
        ];
        let rejected = false;
        try {
          await bufferAndRestore(request, 8193);
        } catch {
          rejected = true;
        }
        return {
          rejected,
          removed: baseline.every(
            (n, i) =>
              request.listenerCount(
                ["readable", "end", "aborted", "error"][i],
              ) === n,
          ),
        };
      },
      async (socket) => {
        await write(socket, head(8193));
        await write(socket, Buffer.alloc(8193, 66));
      },
    );
    expect(observed).toEqual({ rejected: true, removed: true });
  });

  it("rejects a received chunk longer than the expected length", async () => {
    const rejected = await withBodyFixture(
      async (request) => {
        try {
          await bufferAndRestore(request, 4);
          return false;
        } catch {
          return true;
        }
      },
      async (socket) => {
        await write(socket, head(5) + "abcde");
      },
    );
    expect(rejected).toBe(true);
  });

  it("rejects a complete HTTP body shorter than the supplied expected length", async () => {
    const rejected = await withBodyFixture(
      async (request) => {
        try {
          await bufferAndRestore(request, 5);
          return false;
        } catch {
          return true;
        }
      },
      async (socket) => {
        await write(socket, head(4) + "abcd");
      },
    );
    expect(rejected).toBe(true);
  });

  it("rejects a truncated request when the sending peer closes", async () => {
    const rejected = await withBodyFixture(
      async (request) => {
        try {
          await bufferAndRestore(request, 20);
          return false;
        } catch {
          return true;
        }
      },
      async (socket) => {
        await write(socket, head(20) + "short");
        socket.end();
      },
    );
    expect(rejected).toBe(true);
  });

  it("rejects a peer abort after a confirmed readable fragment", async () => {
    let readable!: () => void;
    const started = new Promise<void>((resolve) => {
      readable = resolve;
    });
    const rejected = await withBodyFixture(
      async (request) => {
        request.once("readable", readable);
        try {
          await bufferAndRestore(request, 20);
          return false;
        } catch {
          return true;
        }
      },
      async (socket) => {
        await write(socket, head(20) + "short");
        await started;
        socket.destroy();
      },
    );
    expect(rejected).toBe(true);
  });

  it("settles on an externally enforced request deadline with no retained body listeners", async () => {
    const observed = await withBodyFixture(
      async (request) => {
        const before = request.listenerCount("readable");
        // bufferAndRestore has no independent deadline: the owned host must destroy.
        const deadline = setTimeout(() => request.destroy(), 30);
        try {
          await bufferAndRestore(request, 20);
          return { rejected: false, removed: false };
        } catch {
          return {
            rejected: true,
            removed: request.listenerCount("readable") === before,
          };
        } finally {
          clearTimeout(deadline);
        }
      },
      async (socket) => {
        await write(socket, head(20));
      },
    );
    expect(observed).toEqual({ rejected: true, removed: true });
  });
});

const publicId = "a".repeat(40);
const unknownId = "b".repeat(40);
const known = new Set([publicId]);
const nonce = `v1.1700000000000.${"c".repeat(32)}.${"d".repeat(64)}`;
const boundary = "BookStoreSyntheticBoundary";
const contentType = `multipart/form-data; boundary=${boundary}`;
type Field = readonly [name: string, value: string, file?: boolean];
function multipart(fields: readonly Field[], close = true): Buffer {
  let text = "";
  for (const [name, value, file] of fields) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file ? '; filename="synthetic.txt"' : ""}\r\n${file ? "Content-Type: text/plain\r\n" : ""}\r\n${value}\r\n`;
  }
  if (close) text += `--${boundary}--\r\n`;
  return Buffer.from(text);
}
const nativeFields: readonly Field[] = [
  [`$ACTION_ID_${publicId}`, ""],
  ["csrf", nonce],
];
// Exact pinned React encoder order: referenced FormData fields precede root 0.
const flightFields: readonly Field[] = [
  ["_1_csrf", nonce],
  ["0", '["$K1"]'],
];

describe("bounded native unbound Action wire subset (no Action execution)", () => {
  for (const [name, fields] of [
    ["native", nativeFields],
    ["Flight", flightFields],
  ] as const) {
    it(`restores an actual ${name} multipart fixture into a subsequent web arrayBuffer consumer`, async () => {
      const body = multipart(fields);
      const observed = await withBodyFixture(
        (request) => replay(request, body.length, "web", body),
        async (socket) => {
          await write(socket, head(body.length));
          await write(socket, body);
        },
      );
      expectExactOrderedReplay(observed);
    });
  }
  it("accepts a known public native marker and one syntactic CSRF nonce", async () => {
    expect(
      await validActionBody(
        multipart(nativeFields),
        contentType,
        undefined,
        known,
      ),
    ).toBe(true);
  });
  it("accepts actual enhanced FormData Flight envelope for a known action header", async () => {
    expect(
      await validActionBody(
        multipart(flightFields),
        contentType,
        publicId,
        known,
      ),
    ).toBe(true);
  });
  const invalid: Array<{
    name: string;
    fields: readonly Field[];
    id?: string;
  }> = [
    {
      name: "unknown native action",
      fields: [
        [`$ACTION_ID_${unknownId}`, ""],
        ["csrf", nonce],
      ],
    },
    { name: "unknown enhanced action", fields: flightFields, id: unknownId },
    {
      name: "native duplicate CSRF",
      fields: [...nativeFields, ["csrf", nonce]],
    },
    {
      name: "enhanced duplicate CSRF",
      fields: [
        ["_1_csrf", nonce],
        ["_1_csrf", nonce],
        ["0", '["$K1"]'],
      ],
      id: publicId,
    },
    {
      name: "native duplicate public marker",
      fields: [...nativeFields, [`$ACTION_ID_${publicId}`, ""]],
    },
    {
      name: "native File nonce",
      fields: [
        [`$ACTION_ID_${publicId}`, ""],
        ["csrf", nonce, true],
      ],
    },
    {
      name: "enhanced File nonce",
      fields: [
        ["_1_csrf", nonce, true],
        ["0", '["$K1"]'],
      ],
      id: publicId,
    },
    {
      name: "bound action reference",
      fields: [
        ["$ACTION_REF_0", ""],
        ["csrf", nonce],
      ],
    },
    {
      name: "nonempty marker",
      fields: [
        [`$ACTION_ID_${publicId}`, "x"],
        ["csrf", nonce],
      ],
    },
    {
      name: "nested Flight reference",
      fields: [
        ["_1_csrf", nonce],
        ["0", '["$K2"]'],
      ],
      id: publicId,
    },
    {
      name: "bound actor arguments",
      fields: [
        ["_1_csrf", nonce],
        ["0", '["$K1","actor"]'],
      ],
      id: publicId,
    },
    {
      name: "obsolete enhanced field prefix",
      fields: [
        ["1_csrf", nonce],
        ["0", '["$K1"]'],
      ],
      id: publicId,
    },
    {
      name: "streaming root before referenced FormData fields",
      fields: [
        ["0", '["$K1"]'],
        ["_1_csrf", nonce],
      ],
      id: publicId,
    },
    {
      name: "native actor claim",
      fields: [...nativeFields, ["actor", "synthetic"]],
    },
    { name: "native role claim", fields: [...nativeFields, ["role", "owner"]] },
    {
      name: "native target",
      fields: [...nativeFields, ["target", "synthetic"]],
    },
    { name: "native return URL", fields: [...nativeFields, ["returnTo", "/"]] },
    {
      name: "enhanced user claim",
      fields: [
        ["_1_csrf", nonce],
        ["_1_user", "synthetic"],
        ["0", '["$K1"]'],
      ],
      id: publicId,
    },
    {
      name: "bad nonce grammar",
      fields: [
        [`$ACTION_ID_${publicId}`, ""],
        ["csrf", "not-a-nonce"],
      ],
    },
    {
      name: "oversized nonce",
      fields: [
        [`$ACTION_ID_${publicId}`, ""],
        ["csrf", "x".repeat(8193)],
      ],
    },
    { name: "missing nonce", fields: [[`$ACTION_ID_${publicId}`, ""]] },
    { name: "empty form", fields: [] },
  ];
  for (const row of invalid)
    it(`rejects ${row.name}`, async () => {
      expect(
        await validActionBody(
          multipart(row.fields),
          contentType,
          row.id,
          known,
        ),
      ).toBe(false);
    });
  for (const type of [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data",
    "multipart/form-data; boundary=",
    `multipart/form-data; boundary=${"x".repeat(101)}`,
  ]) {
    it(`rejects unsupported content-type fixture ${type.length}`, async () => {
      expect(
        await validActionBody(multipart(nativeFields), type, undefined, known),
      ).toBe(false);
    });
  }
  it("rejects a mismatched multipart boundary", async () => {
    expect(
      await validActionBody(
        multipart(nativeFields),
        "multipart/form-data; boundary=wrong",
        undefined,
        known,
      ),
    ).toBe(false);
  });
  it("rejects a truncated multipart body", async () => {
    expect(
      await validActionBody(
        multipart(nativeFields, false),
        contentType,
        undefined,
        known,
      ),
    ).toBe(false);
  });
  it("rejects invalid UTF8 in the syntactically required nonce", async () => {
    const body = multipart(nativeFields);
    const start = body.indexOf(nonce);
    body[start + 3] = 255;
    expect(await validActionBody(body, contentType, undefined, known)).toBe(
      false,
    );
  });
});

function parsedHeaders(
  pairs: readonly string[],
  method?: string,
): Map<string, string> | null {
  const socket = new Socket();
  try {
    const request = new IncomingMessage(socket);
    if (method !== undefined) request.method = method;
    request.rawHeaders = [...pairs];
    return nextRawHeaders(request);
  } finally {
    socket.destroy();
  }
}
const requestedMethodName = "Access-Control-Request-Method";
const requestedHeadersName = "Access-Control-Request-Headers";
function denialPreflight(
  method = "POST",
  headers = "content-type,x-bookstore-csrf",
) {
  return [requestedMethodName, method, requestedHeadersName, headers];
}
describe("OPTIONS denial preflight metadata grammar only (never CORS approval)", () => {
  it("recognizes exact browser metadata so the outer method gate can return 405", () => {
    const headers = parsedHeaders(
      [
        "Host",
        "bookstore-transport.invalid:3463",
        "Origin",
        "http://foreign-transport.invalid:3464",
        ...denialPreflight(),
      ],
      "OPTIONS",
    );
    expect(
      headers instanceof Map &&
        headers.get("access-control-request-method") === "POST" &&
        headers.get("access-control-request-headers") ===
          "content-type,x-bookstore-csrf",
    ).toBe(true);
  });
  it("does not require preflight metadata for an ordinary OPTIONS method denial", () => {
    expect(
      parsedHeaders(
        ["Host", "bookstore-transport.invalid:3463"],
        "OPTIONS",
      ) instanceof Map,
    ).toBe(true);
  });
  for (const method of ["GET", "POST", "HEAD", "PATCH"]) {
    it(`rejects denial-only preflight headers on ${method}`, () => {
      expect(parsedHeaders(denialPreflight(), method)).toBeNull();
    });
  }
  for (const pairs of [
    [requestedMethodName, "POST"],
    [requestedHeadersName, "content-type,x-bookstore-csrf"],
  ]) {
    it(`rejects incomplete preflight metadata ${pairs[0]}`, () => {
      expect(parsedHeaders(pairs, "OPTIONS")).toBeNull();
    });
  }
  for (const method of [
    "GET",
    "OPTIONS",
    "post",
    "POST,DELETE",
    " POST",
    "POST ",
    "",
  ]) {
    it(`rejects unsupported requested method fixture ${method.length}`, () => {
      expect(parsedHeaders(denialPreflight(method), "OPTIONS")).toBeNull();
    });
  }
  for (const headers of [
    "x-bookstore-csrf,content-type",
    "Content-Type,x-bookstore-csrf",
    "content-type, x-bookstore-csrf",
    "content-type",
    "content-type,x-bookstore-csrf,x-actor",
    "content-type,x-bookstore-csrf,x-forwarded-for",
    "*",
    "",
    "x".repeat(8193),
    "content-type,\nx-bookstore-csrf",
    "\u0000",
  ]) {
    it(`rejects noncanonical or unknown requested headers fixture ${headers.length}`, () => {
      expect(
        parsedHeaders(denialPreflight("POST", headers), "OPTIONS"),
      ).toBeNull();
    });
  }
  it("rejects a duplicate requested method despite identical values", () => {
    expect(
      parsedHeaders(
        [...denialPreflight(), "access-control-request-method", "POST"],
        "OPTIONS",
      ),
    ).toBeNull();
  });
  it("rejects a duplicate requested-header list despite identical values", () => {
    expect(
      parsedHeaders(
        [
          ...denialPreflight(),
          "access-control-request-headers",
          "content-type,x-bookstore-csrf",
        ],
        "OPTIONS",
      ),
    ).toBeNull();
  });
});

type RouterFixture = [unknown, Record<string, RouterFixture>, ...unknown[]];
function routerFixture(): RouterFixture {
  return [
    "",
    {
      children: ["%5F_bookstore_next_security", { children: ["__PAGE__", {}] }],
    },
    null,
    null,
    16,
  ];
}
function changedRouterFixture(
  change: (tree: RouterFixture) => void,
): RouterFixture {
  const tree = routerFixture();
  change(tree);
  return tree;
}
function routerHeaders(tree: unknown): Map<string, string> | null {
  return parsedHeaders([
    "Next-Router-State-Tree",
    encodeURIComponent(JSON.stringify(tree)),
  ]);
}

describe("raw-header grammar only (not Origin authorization)", () => {
  it("accepts bounded known headers without claiming an Origin decision", () => {
    const result = parsedHeaders([
      "Host",
      "bookstore-transport.invalid:3463",
      "Content-Length",
      "0",
    ]);
    expect(result?.get("host")).toBe("bookstore-transport.invalid:3463");
    expect(result?.has("origin")).toBe(false);
  });
  for (const name of [
    "Forwarded",
    "X-Forwarded-Host",
    "X-Forwarded-Proto",
    "X-Forwarded-For",
    "X-Real-IP",
    "X-Action-Forwarded",
    "X-Middleware-Subrequest",
    "X-Nextjs-Revalidated-Tag-Token",
    "Transfer-Encoding",
    "Trailer",
    "Expect",
    "Upgrade",
    "Content-Encoding",
    "X-HTTP-Method-Override",
    "Traceparent",
    "Baggage",
    "Unknown-Header",
  ]) {
    it(`rejects supplied ${name}`, () =>
      expect(parsedHeaders(["Host", "localhost", name, "x"])).toBeNull());
  }
  it("rejects case-insensitive duplicates", () =>
    expect(
      parsedHeaders(["Host", "localhost", "hOsT", "localhost"]),
    ).toBeNull());
  it("rejects duplicate Origin even if identical", () =>
    expect(
      parsedHeaders([
        "Origin",
        "https://example.invalid",
        "origin",
        "https://example.invalid",
      ]),
    ).toBeNull());
  it("rejects unpaired raw entries", () =>
    expect(parsedHeaders(["Host"])).toBeNull());
  it("rejects more than 48 raw header pairs", () =>
    expect(
      parsedHeaders(
        Array.from({ length: 49 }, () => ["Host", "localhost"]).flat(),
      ),
    ).toBeNull());
  for (const value of ["x\ny", "x\ry", "x\ty", "café", "\u0000"]) {
    it(`rejects non-printable/non-ASCII header fixture ${Buffer.byteLength(value)}`, () =>
      expect(parsedHeaders(["User-Agent", value])).toBeNull());
  }
  for (const [name, value] of [
    ["RSC", "0"],
    ["Next-Router-Prefetch", "0"],
    ["Next-Router-Segment-Prefetch", "/foreign"],
    ["Next-Url", "/foreign"],
    ["Next-Router-State-Tree", "%"],
    ["Next-Router-State-Tree", JSON.stringify(["actor"])],
    ["Next-Router-State-Tree", JSON.stringify({ actor: "x" })],
    ["Next-Router-State-Tree", "x".repeat(2049)],
  ] as const) {
    it(`rejects invalid framework header ${name} fixture ${value.length}`, () =>
      expect(parsedHeaders([name, value])).toBeNull());
  }
  it("accepts the designated-page router tree and bounded public framework markers", () => {
    const tree = encodeURIComponent(JSON.stringify(routerFixture()));
    expect(
      parsedHeaders([
        "RSC",
        "1",
        "Next-Url",
        "/__bookstore_next_security",
        "Next-Router-Prefetch",
        "1",
        "Next-Router-Segment-Prefetch",
        "/_tree",
        "Next-Router-State-Tree",
        tree,
      ]) instanceof Map,
    ).toBe(true);
  });
  it("accepts omitted optional router tuple fields without accepting other routes", () => {
    expect(
      routerHeaders(
        changedRouterFixture((tree) => {
          tree.length = 2;
        }),
      ) instanceof Map,
    ).toBe(true);
  });
  it("accepts only build-positioned null and zero child hints", () => {
    const tree = changedRouterFixture((root) => {
      root[4] = null;
      root[1].children.push(null, null, 0);
      root[1].children[1].children.push(null, null, 0);
    });
    expect(routerHeaders(tree) instanceof Map).toBe(true);
  });
  for (const marker of ["refetch", "inside-shared-layout", "metadata-only"]) {
    it(`accepts documented refresh marker ${marker} only in slot three`, () => {
      const tree = changedRouterFixture((root) => {
        root[3] = marker;
        root[1].children.push(null, marker, 0);
      });
      expect(routerHeaders(tree) instanceof Map).toBe(true);
    });
  }
  for (const bit of [0, 1, 32, 1024, -1, 16.5, true, "16"]) {
    it(`rejects wrong root hint fixture ${String(bit)}`, () => {
      expect(
        routerHeaders(
          changedRouterFixture((tree) => {
            tree[4] = bit;
          }),
        ),
      ).toBeNull();
    });
  }
  const wrongTrees: Array<[string, unknown]> = [
    [
      "decoded physical segment alias",
      changedRouterFixture((tree) => {
        tree[1].children[0] = "__bookstore_next_security";
      }),
    ],
    [
      "double-encoded physical segment alias",
      changedRouterFixture((tree) => {
        tree[1].children[0] = "%255F_bookstore_next_security";
      }),
    ],
    [
      "physical segment in root position",
      changedRouterFixture((tree) => {
        tree[0] = "%5F_bookstore_next_security";
      }),
    ],
    [
      "unknown leaf",
      changedRouterFixture((tree) => {
        tree[1].children[1].children[0] = "__DEFAULT__";
      }),
    ],
    [
      "root bit on child",
      changedRouterFixture((tree) => {
        tree[1].children.push(null, null, 16);
      }),
    ],
    [
      "root bit on leaf",
      changedRouterFixture((tree) => {
        tree[1].children[1].children.push(null, null, 16);
      }),
    ],
    [
      "hint in refresh-state slot",
      changedRouterFixture((tree) => {
        tree[2] = 16;
      }),
    ],
    [
      "hint in marker slot",
      changedRouterFixture((tree) => {
        tree[3] = 16;
      }),
    ],
    [
      "hint in removed search slot",
      changedRouterFixture((tree) => {
        tree.push(16);
      }),
    ],
    [
      "removed empty search slot",
      changedRouterFixture((tree) => {
        tree.push("");
      }),
    ],
    [
      "literal same-page URL in stripped refresh state",
      changedRouterFixture((tree) => {
        tree[2] = "/__bookstore_next_security";
      }),
    ],
    [
      "compressed URL state stripped by client",
      changedRouterFixture((tree) => {
        tree[2] = ["/__bookstore_next_security", ""];
      }),
    ],
    [
      "foreign callback in refresh state",
      changedRouterFixture((tree) => {
        tree[2] = ["//foreign.invalid", ""];
      }),
    ],
    [
      "unknown refresh marker",
      changedRouterFixture((tree) => {
        tree[3] = "actor";
      }),
    ],
    [
      "known marker in route position",
      changedRouterFixture((tree) => {
        tree[1].children[0] = "refetch";
      }),
    ],
    [
      "parallel route selector",
      changedRouterFixture((tree) => {
        tree[1].other = tree[1].children;
      }),
    ],
    [
      "actor object field",
      changedRouterFixture((tree) => {
        tree[1].actor = ["__PAGE__", {}];
      }),
    ],
    [
      "skipped physical page node",
      changedRouterFixture((tree) => {
        tree[1].children = ["__PAGE__", {}];
      }),
    ],
    [
      "extra leaf child",
      changedRouterFixture((tree) => {
        tree[1].children[1].children[1].children = ["__PAGE__", {}];
      }),
    ],
    [
      "encoded callback segment",
      changedRouterFixture((tree) => {
        tree[1].children[0] = "%2f%2fforeign.invalid";
      }),
    ],
    [
      "nested object instead of hint",
      changedRouterFixture((tree) => {
        tree[4] = { role: "Owner" };
      }),
    ],
    ["root primitive", 16],
    ["root boolean", true],
    ["root object", { children: routerFixture() }],
    ["missing children", ["", {}]],
  ];
  for (const [name, tree] of wrongTrees) {
    it(`rejects structural router tree ${name}`, () =>
      expect(routerHeaders(tree)).toBeNull());
  }
  it("decodes the complete router header exactly once", () => {
    const once = encodeURIComponent(JSON.stringify(routerFixture()));
    expect(parsedHeaders(["Next-Router-State-Tree", once]) instanceof Map).toBe(
      true,
    );
    expect(
      parsedHeaders(["Next-Router-State-Tree", encodeURIComponent(once)]),
    ).toBeNull();
  });
  it("rejects an explicitly empty router header", () =>
    expect(parsedHeaders(["Next-Router-State-Tree", ""])).toBeNull());
});
