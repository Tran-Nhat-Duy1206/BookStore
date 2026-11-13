import "server-only";
import { cookies } from "next/headers";
import type { TransportRoute } from "../../../../src/server/security/https-transport-policy";
import { nextSecurityRequest } from "../../runtime/context";
import { nextCookieHeader } from "./cookie-header";

const paths: Record<TransportRoute, string> = {
  password: "/__bookstore_next_auth/password",
  totp: "/__bookstore_next_auth/totp/verify",
  stepUp: "/__bookstore_next_auth/step-up",
  session: "/__bookstore_next_auth/session",
  signOut: "/__bookstore_next_auth/sign-out",
};
const headers = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
};
function denied() {
  return Response.json(
    { state: "denied", applicationAdmission: "disabled" },
    { status: 403, headers },
  );
}

/** Raw ingress already validated framing, bytes, Origin and CSRF before Next. */
export async function authPost(
  request: Request,
  route: TransportRoute,
): Promise<Response> {
  try {
    if (route === "totp") console.info("BookStore Next TOTP route entered.");
    const cookieStore = await cookies();
    const context = nextSecurityRequest();
    const url = new URL(request.url);
    const length = request.headers.get("content-length");
    if (
      request.method !== "POST" ||
      context.method !== "POST" ||
      context.path !== paths[route] ||
      url.pathname !== paths[route] ||
      url.search ||
      length === null ||
      !/^(0|[1-9][0-9]{0,3})$/.test(length) ||
      Number(length) > 1024
    )
      return denied();
    // Consume the restored, bounded native request FIRST. HTTP parser completion
    // is required before cookie/SDK/SQL operations, not before Next's decoder.
    const body = new Uint8Array(await request.arrayBuffer());
    const nextMatches = context.cookiesMatch(nextCookieHeader(cookieStore)),
      rawMatches = context.cookiesMatch(request.headers.get("cookie") ?? "");
    if (route === "totp")
      console.info(
        `BookStore Next TOTP route decoded, exact=${body.byteLength === Number(length)}, nextJar=${nextMatches}, rawJar=${rawMatches}.`,
      );
    if (body.byteLength !== Number(length) || !nextMatches || !rawMatches)
      return denied();
    const result = await context.auth(route, body);
    if (route === "totp")
      console.info(`BookStore Next TOTP operation status=${result.status}.`);
    const response = Response.json(
      {
        state: result.state,
        applicationAdmission: result.applicationAdmission,
      },
      { status: result.status, headers },
    );
    for (const cookie of result.cookies)
      response.headers.append("Set-Cookie", cookie);
    return response;
  } catch {
    return denied();
  }
}
