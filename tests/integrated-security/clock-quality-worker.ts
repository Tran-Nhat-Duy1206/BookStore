import { createAdmissionAuthority } from "../../src/server/security/admission-authority";

/** Private cold-process investigation only; never an SDK/MFA authority probe. */
type InvestigationResult = Readonly<{
  v: 1;
  operation: "security.clock-quality-cold";
  initialized: boolean;
  closed: boolean;
  unavailable: boolean;
}>;

function configuration(): { staffUrl: string; verifierUrl: string } {
  const raw = process.env.BOOKSTORE_CLOCK_INVESTIGATION_CONFIG;
  delete process.env.BOOKSTORE_CLOCK_INVESTIGATION_CONFIG;
  if (typeof raw !== "string") throw new Error("Invalid investigation input.");
  const value: unknown = JSON.parse(raw);
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== 2 ||
    !["staffUrl", "verifierUrl"].every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string"
      );
    })
  )
    throw new Error("Invalid investigation input.");
  const fields = value as { staffUrl: string; verifierUrl: string };
  return { staffUrl: fields.staffUrl, verifierUrl: fields.verifierUrl };
}

async function investigate(): Promise<InvestigationResult> {
  let initialized = false;
  let closed = false;
  let unavailable = false;
  let authority:
    Awaited<ReturnType<typeof createAdmissionAuthority>> | undefined;
  try {
    const config = configuration();
    try {
      // Actual eager factory: unchanged role/profile checks and real clock SQL.
      authority = await createAdmissionAuthority(config);
      initialized = true;
    } catch (error) {
      unavailable =
        error instanceof Error && error.message === "metadataUnavailable";
    }
  } catch {
    // Invalid private input is not a clock-quality/unavailability classification.
  } finally {
    if (authority) {
      try {
        await authority.close();
        closed = true;
      } catch {
        // Cleanup failure remains observable without exposing an error or URL.
      }
    }
  }
  return Object.freeze({
    v: 1,
    operation: "security.clock-quality-cold",
    initialized,
    closed,
    unavailable,
  });
}

async function main(): Promise<void> {
  // No IPC is a harness failure, not a successful standalone invocation.
  if (!process.send || !process.connected) {
    delete process.env.BOOKSTORE_CLOCK_INVESTIGATION_CONFIG;
    process.exitCode = 1;
    return;
  }
  try {
    const result = await investigate();
    await new Promise<void>((resolve, reject) => {
      process.send!(result, (error: Error | null) => {
        if (error) reject(new Error("Investigation IPC unavailable."));
        else resolve();
      });
    });
  } catch {
    process.exitCode = 1;
  } finally {
    if (process.connected) process.disconnect?.();
  }
}

await main();
