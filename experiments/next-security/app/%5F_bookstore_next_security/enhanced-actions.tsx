"use client";

import { useState, useSyncExternalStore, useTransition } from "react";

// UI readiness ONLY, never session/MFA/admission evidence or a server argument.
const subscribeHydration = () => () => {};
const clientHydrated = () => true;
const serverHydrated = () => false;
import { probeAction, revokeSelfAction, signOutAction } from "./actions";

type Nonces = { probe?: string; revokeSelf?: string; signOut: string };
export default function EnhancedActions({ nonces }: { nonces: Nonces }) {
  const hydrated = useSyncExternalStore(
    subscribeHydration,
    clientHydrated,
    serverHydrated,
  );
  const [pending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState("not-requested");
  function invoke(kind: "probe" | "revoke-self" | "sign-out") {
    const nonce =
      kind === "probe"
        ? nonces.probe
        : kind === "revoke-self"
          ? nonces.revokeSelf
          : nonces.signOut;
    if (!nonce) return;
    const data = new FormData();
    data.set("csrf", nonce);
    startTransition(async () => {
      try {
        if (kind === "probe") await probeAction(data);
        else if (kind === "revoke-self") await revokeSelfAction(data);
        else await signOutAction(data);
        setOutcome("completed-without-application-admission");
      } catch {
        setOutcome("denied-or-unavailable");
      }
    });
  }
  return (
    <section
      aria-label="Enhanced native action probes"
      data-hydrated={hydrated ? "ready" : "pending"}
    >
      {nonces.probe ? (
        <button
          type="button"
          disabled={pending || !hydrated}
          data-enhanced="probe"
          onClick={() => invoke("probe")}
        >
          Enhanced probe
        </button>
      ) : null}
      {nonces.revokeSelf ? (
        <button
          type="button"
          disabled={pending || !hydrated}
          data-enhanced="revoke-self"
          onClick={() => invoke("revoke-self")}
        >
          Enhanced revoke self
        </button>
      ) : null}
      <button
        type="button"
        disabled={pending || !hydrated}
        data-enhanced="sign-out"
        onClick={() => invoke("sign-out")}
      >
        Enhanced sign out
      </button>
      <output aria-live="polite" data-action-outcome={outcome}>
        {outcome}
      </output>
    </section>
  );
}
