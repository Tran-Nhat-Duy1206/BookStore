import { request } from "node:https";
import { connect, type TLSSocket } from "node:tls";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TRANSPORT_HOST, type TransportCertificates } from "./certificates";
import type { RestrictedHttpsTestTransportConfig } from "../../src/server/security/https-transport";

export const WIRE_PATHS = Object.freeze({
  password: "/__bookstore_test_auth/password",
  totp: "/__bookstore_test_auth/totp/verify",
  stepUp: "/__bookstore_test_auth/step-up",
  session: "/__bookstore_test_auth/session",
  signOut: "/__bookstore_test_auth/sign-out",
});
export type WireRoute = keyof typeof WIRE_PATHS;
export interface WireResponse {
  status: number;
  state: string | null;
  applicationDisabled: boolean;
  cookies: readonly string[];
  body: string;
  noStore: boolean;
  location: boolean;
  authorized: boolean;
}
export interface WireOptions {
  method?: string;
  path?: string;
  body?: string | Buffer;
  headers?: Record<string, string | null>;
  extraHeaders?: string[];
  cookie?: string;
  absorb?: boolean;
}
/** Header replay helper only. No browser Secure/SameSite/HttpOnly acceptance claim. */
export class WireJar {
  private values = new Map<string, string>();
  get header(): string {
    return [...this.values]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }
  get size(): number {
    return this.values.size;
  }
  clone(): WireJar {
    const result = new WireJar();
    result.values = new Map(this.values);
    return result;
  }
  absorb(lines: readonly string[]): void {
    for (const line of lines) {
      const first = line.split(";", 1)[0],
        at = first.indexOf("=");
      if (at < 1) throw new Error("Synthetic cookie header invalid.");
      const key = first.slice(0, at),
        value = first.slice(at + 1);
      if (!value || /(?:^|;)\s*max-age=0(?:;|$)/i.test(line))
        this.values.delete(key);
      else this.values.set(key, value);
    }
  }
}
function response(
  status: number,
  body: string,
  cookies: readonly string[],
  noStore: boolean,
  location: boolean,
  authorized: boolean,
): WireResponse {
  let state: string | null = null,
    applicationDisabled = false;
  try {
    const parsed = JSON.parse(body);
    if (typeof parsed.state === "string") state = parsed.state;
    applicationDisabled =
      parsed.applicationAdmission === "disabled" &&
      Object.keys(parsed).sort().join(",") === "applicationAdmission,state";
  } catch {}
  return {
    status,
    state,
    applicationDisabled,
    cookies,
    body,
    noStore,
    location,
    authorized,
  };
}
export class WireClient {
  readonly jar = new WireJar();
  readonly origin: string;
  constructor(
    private readonly ca: string,
    readonly port: 3443 | 3445 = 3443,
  ) {
    this.origin = `https://${TRANSPORT_HOST}:${port}`;
  }
  async post(
    route: WireRoute,
    data: Record<string, string> = {},
    options: WireOptions = {},
  ): Promise<WireResponse> {
    return this.send(WIRE_PATHS[route], data, options);
  }
  async send(
    target: string,
    data: Record<string, string> = {},
    options: WireOptions = {},
  ): Promise<WireResponse> {
    const body = options.body ?? JSON.stringify(data);
    const headers: Record<string, string> = {
      Host: `${TRANSPORT_HOST}:${this.port}`,
      Origin: this.origin,
      "X-Bookstore-CSRF": "1",
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      Connection: "close",
    };
    const cookie = options.cookie ?? this.jar.header;
    if (cookie) headers.Cookie = cookie;
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const old = Object.keys(headers).find(
        (k) => k.toLowerCase() === name.toLowerCase(),
      );
      if (old) delete headers[old];
      if (value !== null) headers[name] = value;
    }
    const raw = Object.entries(headers).flatMap(([key, value]) => [key, value]);
    raw.push(...(options.extraHeaders ?? []));
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: TRANSPORT_HOST,
          servername: TRANSPORT_HOST,
          port: this.port,
          path: options.path ?? target,
          method: options.method ?? "POST",
          headers: raw,
          ca: this.ca,
          rejectUnauthorized: true,
          agent: false,
          lookup: (hostname, opts, callback) => {
            if (hostname !== TRANSPORT_HOST) {
              callback(new Error("Private DNS rejected."), "", 4);
              return;
            }
            if (opts.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
          timeout: 8000,
        },
        (res) => {
          const authorized = (res.socket as TLSSocket).authorized;
          let text = "";
          res.on("data", (chunk: Buffer) => {
            text += chunk.toString("utf8");
            if (text.length > 8192) req.destroy();
          });
          res.once("end", () => {
            const lines = res.headers["set-cookie"] ?? [];
            if (options.absorb !== false) this.jar.absorb(lines);
            resolve(
              response(
                res.statusCode ?? 0,
                text,
                lines,
                res.headers["cache-control"] === "private, no-store",
                !!res.headers.location,
                authorized,
              ),
            );
          });
          res.once("error", () =>
            reject(
              new Error(
                "Synthetic HTTPS response unavailable; details suppressed.",
              ),
            ),
          );
        },
      );
      req.once("timeout", () => req.destroy());
      req.once("error", () =>
        reject(
          new Error("Synthetic HTTPS request unavailable; details suppressed."),
        ),
      );
      req.end(body);
    });
  }
  /** Actual client disconnect probe; never accepts a TLS-verification override. */
  abortablePost(
    route: WireRoute,
    data: Record<string, string>,
  ): {
    abort(): void;
    done: Promise<{
      aborted: boolean;
      receivedResponse: boolean;
      authorized: boolean;
    }>;
  } {
    let abort = () => {};
    const done = new Promise<{
      aborted: boolean;
      receivedResponse: boolean;
      authorized: boolean;
    }>((resolve, reject) => {
      let intentional = false,
        receivedResponse = false,
        authorized = false;
      const body = JSON.stringify(data);
      const req = request(
        {
          hostname: TRANSPORT_HOST,
          servername: TRANSPORT_HOST,
          port: this.port,
          path: WIRE_PATHS[route],
          method: "POST",
          ca: this.ca,
          rejectUnauthorized: true,
          agent: false,
          headers: {
            Host: `${TRANSPORT_HOST}:${this.port}`,
            Origin: this.origin,
            "X-Bookstore-CSRF": "1",
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(body)),
            Connection: "close",
            Cookie: this.jar.header,
          },
          lookup: (hostname, opts, callback) => {
            if (hostname !== TRANSPORT_HOST) {
              callback(new Error("Private DNS rejected."), "", 4);
              return;
            }
            if (opts.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
          timeout: 8000,
        },
        (res) => {
          receivedResponse = true;
          res.resume();
        },
      );
      req.once("socket", (socket) => {
        socket.once("secureConnect", () => {
          authorized = (socket as TLSSocket).authorized;
        });
      });
      req.once("timeout", () => req.destroy());
      req.once("error", () => {
        if (!intentional)
          reject(
            new Error("Synthetic abort probe unavailable; details suppressed."),
          );
      });
      req.once("close", () =>
        resolve({ aborted: intentional, receivedResponse, authorized }),
      );
      abort = () => {
        intentional = true;
        req.destroy();
      };
      req.end(body);
    });
    return { abort: () => abort(), done };
  }
  /** Exact HTTP/1 bytes inside normally CA-verified TLS, for parser adversaries. */
  async raw(bytes: string): Promise<{
    status: number;
    applicationDisabled: boolean;
    noStore: boolean;
    cookies: boolean;
  }> {
    return new Promise((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port: this.port,
        servername: TRANSPORT_HOST,
        ca: this.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
      });
      let text = "";
      socket.setTimeout(8000, () => socket.destroy());
      socket.once("secureConnect", () => socket.write(bytes));
      socket.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (text.length > 16384) socket.destroy();
      });
      socket.once("error", () =>
        reject(
          new Error(
            "Synthetic raw HTTPS request unavailable; details suppressed.",
          ),
        ),
      );
      socket.once("close", () => {
        const match = /^HTTP\/1\.1 ([0-9]{3})/.exec(text);
        resolve({
          status: match ? Number(match[1]) : 0,
          applicationDisabled: text.includes(
            '"applicationAdmission":"disabled"',
          ),
          noStore: /cache-control: private, no-store/i.test(text),
          cookies: /\r\nset-cookie:/i.test(text),
        });
      });
    });
  }
}
export function allCookiesCleared(response: WireResponse): boolean {
  return (
    response.cookies.length === 5 &&
    response.cookies.every(
      (line) =>
        /^[^=]+=;/.test(line) &&
        /Max-Age=0/.test(line) &&
        /Secure/.test(line) &&
        /HttpOnly/.test(line) &&
        /SameSite=Strict/.test(line) &&
        /Path=\//.test(line) &&
        !/(?:^|;)\s*Domain=/i.test(line),
    )
  );
}
export function cookieAttributesValid(response: WireResponse): boolean {
  return response.cookies.every(
    (line) =>
      /(?:^|;)\s*Secure(?:;|$)/.test(line) &&
      /(?:^|;)\s*HttpOnly(?:;|$)/.test(line) &&
      /(?:^|;)\s*SameSite=Strict(?:;|$)/.test(line) &&
      /(?:^|;)\s*Path=\/(?:;|$)/.test(line) &&
      !/(?:^|;)\s*Domain=/i.test(line),
  );
}

export async function startWireWorker(
  config: RestrictedHttpsTestTransportConfig,
): Promise<{ close(): Promise<void> }> {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "test",
    BOOKSTORE_RESTRICTED_HTTPS_TEST: "1",
    TSX_DISABLE_CACHE: "1",
  };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "ComSpec",
    "PATHEXT",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  env.BOOKSTORE_HTTPS_WORKER = JSON.stringify(config);
  let child: ChildProcess;
  return new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "tsx",
        fileURLToPath(new URL("./restart-worker.ts", import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL("../../", import.meta.url)),
        env,
        stdio: ["ignore", "pipe", "ignore", "ipc"],
      },
    );
    let ready = false,
      text = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Synthetic HTTPS child startup timed out."));
    }, 30000);
    child.stdout?.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.length > 256) {
        child.kill();
        reject(new Error("Synthetic HTTPS child emitted unexpected output."));
        return;
      }
      if (!ready && text === "HTTPS_READY\n") {
        ready = true;
        clearTimeout(timer);
        resolve({
          close: () =>
            new Promise<void>((done, failed) => {
              if (child.exitCode !== null) {
                if (child.exitCode === 0) done();
                else
                  failed(
                    new Error("Synthetic HTTPS child exited unavailable."),
                  );
                return;
              }
              const stop = setTimeout(() => {
                child.kill();
                failed(new Error("Synthetic HTTPS child close timed out."));
              }, 15000);
              child.once("exit", (code) => {
                clearTimeout(stop);
                if (code === 0) done();
                else
                  failed(new Error("Synthetic HTTPS child close unavailable."));
              });
              child.send("CLOSE");
            }),
        });
      }
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Synthetic HTTPS child unavailable."));
    });
    child.once("exit", () => {
      clearTimeout(timer);
      if (!ready)
        reject(new Error("Synthetic HTTPS child startup unavailable."));
    });
  });
}
export function transportConfig(
  config: {
    authUrl: string;
    staffUrl: string;
    verifierUrl: string;
    secret: string;
  },
  certs: TransportCertificates,
  port: 3443 | 3445 = 3443,
): RestrictedHttpsTestTransportConfig {
  return {
    enabled: true,
    origin: `https://${TRANSPORT_HOST}:${port}`,
    ...config,
    tls: { key: certs.key, cert: certs.cert, ca: certs.ca },
  };
}
