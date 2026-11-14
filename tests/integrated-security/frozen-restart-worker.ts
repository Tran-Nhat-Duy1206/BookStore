import { createDormantAdmissionControls } from "../../src/server/security/provider-proof";

// Private cold Node process, NOT a Next server/listener or a Vitest test. Only
// existing AUTH/STAFF/VERIFIER + provider secret arrive through private env.
// No cookie, actor, proof, Migrate/bootstrap/worker URL or positive operation.
async function deniedAtConstruction(): Promise<boolean> {
  const encoded = process.env.BOOKSTORE_FROZEN_STARTUP_CONFIG;
  delete process.env.BOOKSTORE_FROZEN_STARTUP_CONFIG;
  if (!encoded) return false;
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).sort().join(",") !==
      "authUrl,secret,staffUrl,verifierUrl" ||
    !["authUrl", "staffUrl", "verifierUrl", "secret"].every(
      (key) => typeof input[key] === "string",
    )
  )
    return false;
  try {
    const subject = await createDormantAdmissionControls({
      authUrl: input.authUrl as string,
      staffUrl: input.staffUrl as string,
      verifierUrl: input.verifierUrl as string,
      secret: input.secret as string,
    });
    // An unexpected successful construction must still await all pool cleanup.
    await subject.close();
    return false;
  } catch (error) {
    // Factory authority failure awaits its own pool close before throwing this
    // one exact static alias. Never serialize the exception or private config.
    return error instanceof Error && error.message === "metadataUnavailable";
  }
}

async function main(): Promise<void> {
  let denied = false;
  try {
    denied = await deniedAtConstruction();
  } catch {
    // Only fixed protocol fields below; never raw errors/provider/SQL messages.
  }
  process.exitCode = denied ? 0 : 1;
  if (!process.send || !process.connected) {
    process.exitCode = 1;
    return;
  }
  await new Promise<void>((resolve) => {
    process.send?.(
      { v: 1, operation: "security.frozen-startup-denied", denied },
      (error) => {
        if (error) process.exitCode = 1;
        resolve();
      },
    );
  });
  if (process.connected) process.disconnect?.();
  // Natural exit only: no process.exit() can hide a retained SDK/PG handle.
}
void main().catch(() => {
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
