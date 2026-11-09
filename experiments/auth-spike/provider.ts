import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { twoFactor } from "better-auth/plugins";
import { toNextJsHandler } from "better-auth/next-js";
import type { PrismaClient } from "./generated/client";

// Logical Request origin ONLY. No listener, DNS lookup or application route exists.
export const origin = "https://bookstore-auth-spike.invalid";
export const basePath = "/api/spike-auth";
export const proposedPolicy = Object.freeze({
  absoluteSeconds: 8 * 60 * 60,
  idleSeconds: 30 * 60,
  recentMfaSeconds: 5 * 60,
});

export function createProvider(
  client: PrismaClient,
  secret: string,
  offline = false,
) {
  return betterAuth({
    appName: "BookStore isolated security spike",
    baseURL: origin,
    basePath,
    secret,
    trustedOrigins: [origin],
    database: prismaAdapter(client, {
      provider: "postgresql",
      transaction: true,
    }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !offline,
      minPasswordLength: 15,
    },
    account: { accountLinking: { enabled: false } },
    session: {
      // Candidate policy in a synthetic harness, NOT approved application settings.
      expiresIn: proposedPolicy.absoluteSeconds,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 1000,
      customRules: { "/sign-in/email": { window: 60, max: 50 } },
    },
    disabledPaths: [
      ...(!offline ? ["/sign-up/email"] : []),
      "/sign-in/social",
      "/sign-in/magic-link",
      "/sign-in/email-otp",
      "/sign-in/anonymous",
      "/link-social",
      "/change-email",
      "/update-user",
      "/delete-user",
      "/two-factor/disable",
      "/two-factor/send-otp",
    ],
    advanced: {
      // Better Auth defaults origin checks off in test environments: enable them
      // explicitly so a passing experiment cannot rely on that bypass.
      disableOriginCheck: false,
      disableCSRFCheck: false,
      // Synthetic transport metadata only. A real BFF must derive client IP from
      // a reviewed trusted proxy/socket, never accept this header from browsers.
      ipAddress: { ipAddressHeaders: ["x-spike-client-ip"] },
      useSecureCookies: true,
      defaultCookieAttributes: {
        httpOnly: true,
        secure: true,
        sameSite: "strict",
      },
    },
    plugins: [
      twoFactor({
        issuer: "BookStore spike only",
        skipVerificationOnEnable: false,
        trustDeviceMaxAge: 0,
        backupCodeOptions: { storeBackupCodes: "encrypted" },
        accountLockout: {
          enabled: true,
          maxFailedAttempts: 10,
          durationSeconds: 900,
        },
      }),
    ],
    telemetry: { enabled: false },
    logger: { disabled: true },
  });
}
export type Provider = ReturnType<typeof createProvider>;

let syntheticClient = 0;
/** In-memory synthetic browser. NOT an HTTP server, application BFF or cookie jar. */
export class SyntheticBrowser {
  private cookies = new Map<string, string>();
  private handlers: ReturnType<typeof toNextJsHandler>;
  constructor(
    private provider: Provider,
    private clientIp = `192.0.2.${++syntheticClient}`,
  ) {
    this.handlers = toNextJsHandler(provider);
  }
  get cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  copyCookiesFrom(other: SyntheticBrowser) {
    this.cookies = new Map(other.cookies);
  }
  async call(
    path: string,
    body?: Record<string, unknown>,
    options: { origin?: string; method?: string; cookie?: string } = {},
  ) {
    const method = options.method ?? (body === undefined ? "GET" : "POST");
    const headers = new Headers({
      origin: options.origin ?? origin,
      cookie: options.cookie ?? this.cookieHeader,
      "user-agent": "BookStore synthetic spike browser",
      "content-type": "application/json",
      "x-spike-client-ip": this.clientIp,
    });
    const request = new Request(`${origin}${basePath}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const response =
      await this.handlers[method === "GET" ? "GET" : "POST"](request);
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      const split = pair.indexOf("=");
      const key = pair.slice(0, split),
        value = pair.slice(split + 1);
      if (/max-age=0(?:;|$)/i.test(header) || !value) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return response;
  }
  session() {
    // Raw provider response is private harness data, never a public DTO.
    return this.provider.api.getSession({
      headers: new Headers({ cookie: this.cookieHeader }),
      query: { disableCookieCache: true },
    });
  }
}
