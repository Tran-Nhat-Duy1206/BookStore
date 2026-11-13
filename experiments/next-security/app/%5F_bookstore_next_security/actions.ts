"use server";

import { cookies } from "next/headers";
import { nextCookieHeader } from "../_lib/cookie-header";
import {
  nextSecurityRequest,
  type ActionPurpose,
  type SecurityResult,
} from "../../runtime/context";

const pagePath = "/__bookstore_next_security";
function csrfField(data: FormData): string {
  if (!(data instanceof FormData))
    throw new Error("Isolated security action denied.");
  let csrf: string | undefined;
  let metadata = 0;
  for (const [name, value] of data.entries()) {
    if (
      name === "csrf" &&
      typeof value === "string" &&
      csrf === undefined &&
      value.length <= 1024
    ) {
      csrf = value;
    } else if (
      /^\$ACTION_ID_[0-9a-f]{40,64}$/.test(name) &&
      value === "" &&
      ++metadata === 1
    ) {
      // React may retain this public transport identifier; it conveys no authority.
    } else {
      throw new Error("Isolated security action denied.");
    }
  }
  if (!csrf) throw new Error("Isolated security action denied.");
  return csrf;
}
async function authorized(data: FormData, purpose: ActionPurpose) {
  const cookieStore = await cookies();
  const context = nextSecurityRequest();
  if (
    context.path !== pagePath ||
    context.method !== "POST" ||
    !context.cookiesMatch(nextCookieHeader(cookieStore)) ||
    !context.verifyCsrf(purpose, csrfField(data))
  ) {
    throw new Error("Isolated security action denied.");
  }
  return { context, cookieStore };
}
function requireSuccess(result: SecurityResult): void {
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      result.state === "unavailable"
        ? "Isolated security action unavailable."
        : "Isolated security action denied.",
    );
  }
}

export async function probeAction(data: FormData): Promise<void> {
  const { context } = await authorized(data, "probe");
  const result = await context.read().catch(() => {
    throw new Error("Isolated security action unavailable.");
  });
  requireSuccess(result);
}

export async function revokeSelfAction(data: FormData): Promise<void> {
  const { context } = await authorized(data, "revoke-self");
  const result = await context.revokeSelf().catch(() => {
    throw new Error("Isolated security action unavailable.");
  });
  requireSuccess(result);
}

export async function signOutAction(data: FormData): Promise<void> {
  const { context, cookieStore } = await authorized(data, "sign-out");
  let result: SecurityResult;
  try {
    result = await context.signOut();
  } catch {
    throw new Error("Isolated security action unavailable.");
  } finally {
    // Only a valid Origin/context/CSRF reaches this branch, including uncertainty.
    for (const name of context.cookieNames) {
      cookieStore.set(name, "", {
        maxAge: 0,
        expires: new Date(0),
        secure: true,
        httpOnly: true,
        sameSite: "strict",
        path: "/",
      });
    }
  }
  requireSuccess(result);
}
