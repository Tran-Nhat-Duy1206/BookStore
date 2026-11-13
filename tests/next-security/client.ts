import { request } from "node:https";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { WireJar } from "../https-transport/client";
import type { TransportCertificates } from "../https-transport/certificates";
import type { NextSecurityConfig } from "../../experiments/next-security/runtime/context";
import {
  NEXT_AUTH_PATHS,
  NEXT_HOST,
  SECURITY_PAGE,
} from "../../experiments/next-security/wire";

export interface NextWireResponse {
  status: number;
  state: string | null;
  disabled: boolean;
  authorized: boolean;
  cookies: readonly string[];
  noStore: boolean;
  location: boolean;
  body: string;
  csp: string;
}
export interface NextWireOptions {
  method?: string;
  headers?: Record<string, string | null>;
  cookie?: string;
  absorb?: boolean;
  extraHeaders?: string[];
}
/** Explicit Node header replay, NOT actual browser cookie enforcement. */
export class NextWireClient {
  readonly jar = new WireJar();
  readonly origin: string;
  constructor(
    readonly ca: string,
    readonly port: 3463 | 3465 = 3463,
  ) {
    this.origin = `https://${NEXT_HOST}:${port}`;
  }
  async post(
    route: keyof typeof NEXT_AUTH_PATHS,
    data: Record<string, string> = {},
    options: NextWireOptions = {},
  ) {
    return this.send(NEXT_AUTH_PATHS[route], JSON.stringify(data), {
      ...options,
      method: options.method ?? "POST",
    });
  }
  async page(options: NextWireOptions = {}) {
    return this.send(SECURITY_PAGE, "", {
      ...options,
      method: options.method ?? "GET",
    });
  }
  async send(
    path: string,
    body: string | Buffer = "",
    options: NextWireOptions = {},
  ): Promise<NextWireResponse> {
    const headers: Record<string, string> = {
      Host: `${NEXT_HOST}:${this.port}`,
      Origin: this.origin,
      Connection: "close",
      "Content-Length": String(Buffer.byteLength(body)),
      "Content-Type": "application/json",
      "X-Bookstore-CSRF": "1",
    };
    const cookie = options.cookie ?? this.jar.header;
    if (cookie) headers.Cookie = cookie;
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      const prior = Object.keys(headers).find(
        (key) => key.toLowerCase() === name.toLowerCase(),
      );
      if (prior) delete headers[prior];
      if (value !== null) headers[name] = value;
    }
    const raw = [
      ...Object.entries(headers).flat(),
      ...(options.extraHeaders ?? []),
    ];
    return new Promise((resolveResponse, rejectResponse) => {
      let authorized = false;
      const req = request(
        {
          hostname: NEXT_HOST,
          servername: NEXT_HOST,
          port: this.port,
          path,
          method: options.method ?? "GET",
          headers: raw,
          ca: this.ca,
          rejectUnauthorized: true,
          agent: false,
          timeout: 15000,
          lookup(_hostname, opts, callback) {
            if (typeof opts === "object" && opts.all)
              callback(null, [{ address: "127.0.0.1", family: 4 }]);
            else callback(null, "127.0.0.1", 4);
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk.toString("utf8");
            if (text.length > 524288) req.destroy();
          });
          res.once("end", () => {
            const cookies = res.headers["set-cookie"] ?? [];
            if (options.absorb !== false) this.jar.absorb(cookies);
            let state: string | null = null,
              disabled = false;
            try {
              const parsed: unknown = JSON.parse(text);
              if (
                parsed &&
                typeof parsed === "object" &&
                "state" in parsed &&
                typeof parsed.state === "string"
              )
                state = parsed.state;
              disabled =
                !!parsed &&
                typeof parsed === "object" &&
                "applicationAdmission" in parsed &&
                parsed.applicationAdmission === "disabled" &&
                Object.keys(parsed).sort().join(",") ===
                  "applicationAdmission,state";
            } catch {}
            resolveResponse({
              status: res.statusCode ?? 0,
              state,
              disabled,
              authorized,
              cookies,
              noStore: res.headers["cache-control"] === "private, no-store",
              location: !!res.headers.location,
              body: text,
              csp: String(res.headers["content-security-policy"] ?? ""),
            });
          });
          res.once("error", () =>
            rejectResponse(
              new Error(
                "Synthetic Next HTTPS response unavailable; details suppressed.",
              ),
            ),
          );
        },
      );
      req.on("socket", (socket) =>
        socket.once("secureConnect", () => {
          authorized = "authorized" in socket && socket.authorized === true;
        }),
      );
      req.once("timeout", () => req.destroy());
      req.once("error", () =>
        rejectResponse(
          new Error(
            "Synthetic Next HTTPS request unavailable; details suppressed.",
          ),
        ),
      );
      req.end(body);
    });
  }
  async action(
    id: string,
    csrf: string,
    options: NextWireOptions = {},
    enhanced = false,
    extra: Record<string, string> = {},
  ) {
    const boundary = `----bookstore${randomBytes(12).toString("hex")}`;
    const fields: [string, string][] = enhanced
      ? [["_1_csrf", csrf], ...Object.entries(extra), ["0", '["$K1"]']]
      : [[`$ACTION_ID_${id}`, ""], ["csrf", csrf], ...Object.entries(extra)];
    const body =
      fields
        .map(
          ([name, value]) =>
            `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        )
        .join("") + `--${boundary}--\r\n`;
    return this.send(SECURITY_PAGE, body, {
      ...options,
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        ...(enhanced ? { "Next-Action": id } : {}),
        ...(options.headers ?? {}),
      },
    });
  }
}
export function nativeAction(
  html: string,
  purpose: "probe" | "revoke-self" | "sign-out",
): { id: string; csrf: string } | null {
  const form = new RegExp(
    `<form[^>]*data-native="${purpose}"[^>]*>([\\s\\S]*?)<\\/form>`,
  ).exec(html)?.[1];
  if (!form) return null;
  const id = /name="\$ACTION_ID_([a-f0-9]{40,64})"/.exec(form)?.[1];
  const csrf =
    /name="csrf" value="(v1\.[0-9]{13}\.[a-f0-9]{32}\.[a-f0-9]{64})"/.exec(
      form,
    )?.[1];
  return id && csrf ? { id, csrf } : null;
}
export function nextConfig(
  config: {
    authUrl: string;
    staffUrl: string;
    verifierUrl: string;
    secret: string;
  },
  certs: TransportCertificates,
  csrfSecret: string,
  port: 3463 | 3465 = 3463,
): NextSecurityConfig {
  return {
    enabled: true,
    origin: `https://${NEXT_HOST}:${port}`,
    authUrl: config.authUrl,
    staffUrl: config.staffUrl,
    verifierUrl: config.verifierUrl,
    secret: config.secret,
    csrfSecret,
    tls: { key: certs.key, cert: certs.cert, ca: certs.ca },
  };
}
const root = fileURLToPath(new URL("../../", import.meta.url));
function runtimeEnvironment(config: NextSecurityConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    BOOKSTORE_ISOLATED_NEXT_TEST: "1",
    BOOKSTORE_NEXT_SECURITY_CONFIG: JSON.stringify(config),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "ComSpec",
    "PATHEXT",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
export interface NextDiagnostics {
  v: 1;
  servicePublications: number;
  outgoingHttpRequests: number;
  ingressRequests: number;
  tlsErrors: number;
}
export interface NextProcess {
  close(): Promise<void>;
  kill(): Promise<void>;
  logContains(value: string): boolean;
  diagnostics(): Promise<NextDiagnostics>;
  disconnectSupervisor(): Promise<void>;
}
export async function startNextProcess(
  config: NextSecurityConfig,
): Promise<NextProcess> {
  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", "experiments/next-security/server.ts"],
    {
      cwd: root,
      env: runtimeEnvironment(config),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let logs = "",
    ended = false,
    stage = "entry";
  const stages = [
    "config validated",
    "manifest validated",
    "preparing framework",
    "service published",
    "framework prepared",
  ] as const;
  const exited = new Promise<void>((done) =>
    child.once("exit", () => {
      ended = true;
      done();
    }),
  );
  // Never persist/rethrow this private memory buffer or its request/environment.
  child.stderr?.on("data", (chunk) => {
    logs = (logs + chunk.toString("utf8")).slice(-65536);
  });
  try {
    await new Promise<void>((ready, failed) => {
      let banner = "";
      const timeout = setTimeout(
        () => failed(new Error("Isolated Next ready deadline exceeded.")),
        45000,
      );
      const end = () => {
        clearTimeout(timeout);
        failed(
          new Error("Isolated Next failed before ready; details suppressed."),
        );
      };
      child.once("error", end);
      child.once("exit", end);
      child.stdout?.on("data", (chunk) => {
        logs = (logs + chunk.toString("utf8")).slice(-65536);
        banner = (banner + chunk.toString("utf8")).slice(-8192);
        for (const candidate of stages)
          if (banner.includes(`BookStore Next startup ${candidate}.`))
            stage = candidate;
        if (banner.includes("BookStore isolated Next security ready.")) {
          clearTimeout(timeout);
          child.removeListener("exit", end);
          child.removeListener("error", end);
          ready();
        }
      });
    });
  } catch (error) {
    // Only fixed allowlisted phase/category labels, NEVER private child output.
    const category = logs.includes(
      "construction rejected phase=authority-probe.",
    )
      ? "authority-probe"
      : logs.includes("construction rejected phase=native-provider.")
        ? "native-provider"
        : logs.includes("construction rejected phase=configuration.")
          ? "configuration"
          : logs.includes("ERR_MODULE_NOT_FOUND")
            ? "module"
            : "unclassified";
    console.info(
      `Synthetic Next startup diagnostic phase=${stage}, category=${category}.`,
    );
    if (!ended) child.kill("SIGKILL");
    await exited;
    throw error;
  }
  let closing: Promise<void> | undefined,
    inspecting = false;
  return Object.freeze({
    logContains(value: string) {
      return !!value && logs.includes(value);
    },
    async diagnostics(): Promise<NextDiagnostics> {
      if (ended || !child.connected || inspecting)
        throw new Error("Owned Next diagnostic unavailable.");
      inspecting = true;
      try {
        return await new Promise<NextDiagnostics>((done, failed) => {
          const remove = () => {
            clearTimeout(timeout);
            child.removeListener("message", message);
            child.removeListener("exit", unavailable);
          };
          const unavailable = () => {
            remove();
            failed(new Error("Owned Next diagnostic unavailable."));
          };
          const message = (value: unknown) => {
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).sort().join(",") !==
                "ingressRequests,outgoingHttpRequests,servicePublications,tlsErrors,v"
            )
              return unavailable();
            const data = value as Record<string, unknown>;
            if (
              data.v !== 1 ||
              [
                "servicePublications",
                "outgoingHttpRequests",
                "ingressRequests",
                "tlsErrors",
              ].some(
                (key) =>
                  !Number.isSafeInteger(data[key]) ||
                  Number(data[key]) < 0 ||
                  Number(data[key]) > 1000000,
              )
            )
              return unavailable();
            remove();
            done(
              Object.freeze({
                v: 1,
                servicePublications: Number(data.servicePublications),
                outgoingHttpRequests: Number(data.outgoingHttpRequests),
                ingressRequests: Number(data.ingressRequests),
                tlsErrors: Number(data.tlsErrors),
              }),
            );
          };
          const timeout = setTimeout(unavailable, 5000);
          child.once("message", message);
          child.once("exit", unavailable);
          child.send({ operation: "diagnostics" }, (error) => {
            if (error) unavailable();
          });
        });
      } finally {
        inspecting = false;
      }
    },
    close() {
      return (closing ??= (async () => {
        if (ended) return;
        if (child.connected) child.send({ operation: "close" });
        else child.kill("SIGTERM");
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            exited,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Owned isolated Next close deadline exceeded."),
                  ),
                15000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          if (!ended) {
            child.kill("SIGKILL");
            await exited;
          }
        }
      })());
    },
    async disconnectSupervisor() {
      if (ended) return;
      if (child.connected) child.disconnect();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exited,
          new Promise<never>((_, failed) => {
            timer = setTimeout(
              () =>
                failed(
                  new Error(
                    "Owned Next supervisor-loss cleanup exceeded bound.",
                  ),
                ),
              15000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (!ended) {
          child.kill("SIGKILL");
          await exited;
        }
      }
    },
    async kill() {
      if (!ended) child.kill("SIGKILL");
      await exited;
    },
  });
}
