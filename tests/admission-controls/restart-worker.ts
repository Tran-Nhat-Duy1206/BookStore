import { createDormantAdmissionControls } from "../../src/server/security/provider-proof";

// Executed as a genuine separate Node process, never imported by Vitest discovery.
// Runtime credentials/cookies/capabilities arrive ONLY via this private environment
// channel: no argv/file/stdout credential transport and no bootstrap DB connection.
async function main(): Promise<void> {
  const encoded = process.env.BOOKSTORE_CONTROL_RESTART;
  delete process.env.BOOKSTORE_CONTROL_RESTART;
  if (!encoded) throw new Error("Restart input unavailable.");
  const input = JSON.parse(encoded) as {
    mode: "verify-rejected" | "complete-allowed" | "finalize-allowed";
    config: {
      authUrl: string;
      staffUrl: string;
      verifierUrl: string;
      secret: string;
    };
    cookie: string;
    code?: string;
    evidenceHandle?: string;
  };
  const subject = await createDormantAdmissionControls(input.config);
  try {
    if (input.mode === "verify-rejected") {
      const operation = await subject.verifyTotp(input.code, input.cookie);
      if (operation.response.ok || operation.evidenceHandle !== null)
        throw new Error("Restart replay was not denied.");
    } else if (input.mode === "complete-allowed") {
      // Only a persisted unclaimed primary may resume; no observation/WeakMap
      // object is available in this new process. Invoke the real SDK normally.
      const ready = await subject.verifyTotp(input.code, input.cookie);
      if (!ready.response.ok || !ready.evidenceHandle)
        throw new Error("Restart primary completion failed.");
      const jar = new Map<string, string>();
      for (const piece of input.cookie.split(";")) {
        const split = piece.indexOf("=");
        if (split > 0)
          jar.set(piece.slice(0, split).trim(), piece.slice(split + 1).trim());
      }
      for (const entry of ready.response.headers.getSetCookie()) {
        const first = entry.split(";", 1)[0],
          split = first.indexOf("=");
        const name = first.slice(0, split),
          value = first.slice(split + 1);
        if (!value || /max-age=0(?:;|$)/i.test(entry)) jar.delete(name);
        else jar.set(name, value);
      }
      const cookie = [...jar]
        .map(([key, value]) => `${key}=${value}`)
        .join("; ");
      const finalized = await subject.finalize(ready.evidenceHandle, cookie);
      if (!finalized.response.ok || !(await subject.check(cookie)).allowed)
        throw new Error("Restart dormant admission failed.");
    } else if (input.mode === "finalize-allowed") {
      const finalized = await subject.finalize(
        input.evidenceHandle,
        input.cookie,
      );
      if (
        !finalized.response.ok ||
        !(await subject.check(input.cookie)).allowed
      )
        throw new Error("Restart ready consumption failed.");
    } else throw new Error("Unsupported restart mode.");
  } finally {
    await subject.close();
  }
}

void main().then(
  () => {
    console.log("Synthetic restart gate passed.");
  },
  () => {
    console.error("Synthetic restart gate failed; details suppressed.");
    process.exitCode = 1;
  },
);
