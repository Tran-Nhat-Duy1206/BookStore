import { cookies } from "next/headers";
import { nextCookieHeader } from "../_lib/cookie-header";
import { nextSecurityRequest, type SecurityState } from "../../runtime/context";
import { probeAction, revokeSelfAction, signOutAction } from "./actions";
import EnhancedActions from "./enhanced-actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

type GuardedPageModel =
  | { kind: "denied" | "unavailable" }
  | {
      kind: "result";
      state: SecurityState;
      admitted: boolean;
      nonces: { signOut: string; probe?: string; revokeSelf?: string };
    };

/** Request-local projection only; never a cached or independently trusted guard. */
async function guardedPageModel(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
): Promise<GuardedPageModel> {
  try {
    const context = nextSecurityRequest();
    if (
      context.path !== "/__bookstore_next_security" ||
      !["GET", "POST"].includes(context.method) ||
      !context.cookiesMatch(nextCookieHeader(cookieStore))
    ) {
      return { kind: "denied" };
    }
    const result = await context.read();
    const admitted =
      result.status === 200 && result.state === "verified-test-session";
    const nonces = {
      signOut: context.issueCsrf("sign-out"),
      ...(admitted
        ? {
            probe: context.issueCsrf("probe"),
            revokeSelf: context.issueCsrf("revoke-self"),
          }
        : {}),
    };
    return { kind: "result", state: result.state, admitted, nonces };
  } catch {
    return { kind: "unavailable" };
  }
}

export default async function SecurityProbePage() {
  // Request-time API MUST precede context/SQL so credential-free builds never read it.
  const cookieStore = await cookies();
  const model = await guardedPageModel(cookieStore);
  if (model.kind === "denied") {
    return (
      <main data-security-state="denied" data-application-admission="disabled">
        Isolated security probe denied.
      </main>
    );
  }
  if (model.kind !== "result") {
    return (
      <main
        data-security-state="unavailable"
        data-application-admission="disabled"
      >
        Isolated security probe unavailable.
      </main>
    );
  }
  const { state, admitted, nonces } = model;
  return (
    <main data-security-state={state} data-application-admission="disabled">
      <h1>Isolated synthetic security probe</h1>
      <p>
        Application admission is disabled. This is not a login or administration
        interface.
      </p>
      <p
        data-live-guard={
          admitted ? "admitted-test-session" : "denied-test-session"
        }
      >
        {state}
      </p>
      {nonces.probe ? (
        <form
          action={probeAction}
          encType="multipart/form-data"
          data-native="probe"
        >
          <input type="hidden" name="csrf" value={nonces.probe} />
          <button type="submit">Native read-only probe</button>
        </form>
      ) : null}
      {nonces.revokeSelf ? (
        <form
          action={revokeSelfAction}
          encType="multipart/form-data"
          data-native="revoke-self"
        >
          <input type="hidden" name="csrf" value={nonces.revokeSelf} />
          <button type="submit">Native revoke self</button>
        </form>
      ) : null}
      <form
        action={signOutAction}
        encType="multipart/form-data"
        data-native="sign-out"
      >
        <input type="hidden" name="csrf" value={nonces.signOut} />
        <button type="submit">Native sign out</button>
      </form>
      <EnhancedActions nonces={nonces} />
    </main>
  );
}
