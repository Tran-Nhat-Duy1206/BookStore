import { createReconciliationWorker } from "../src/server/security/reconciliation-worker";

// Private owned non-HTTP child only. The single credential is never in argv,
// stdout, a file, an operation body or an inherited provider environment.
async function main(): Promise<void> {
  const encoded = process.env.BOOKSTORE_RECONCILIATION_CONFIG;
  delete process.env.BOOKSTORE_RECONCILIATION_CONFIG;
  if (
    process.env.BOOKSTORE_ISOLATED_NEXT_TEST !== "1" ||
    !["test", "production"].includes(process.env.NODE_ENV ?? "") ||
    !process.send ||
    !encoded ||
    encoded.length > 4096
  )
    throw new Error("Unavailable");
  const config: unknown = JSON.parse(encoded);
  if (
    !config ||
    typeof config !== "object" ||
    Array.isArray(config) ||
    Object.keys(config).length !== 1 ||
    !Object.hasOwn(config, "workerUrl") ||
    typeof (config as { workerUrl?: unknown }).workerUrl !== "string"
  )
    throw new Error("Unavailable");
  const worker = await createReconciliationWorker(
    config as { workerUrl: string },
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await worker.close();
    } catch {
      process.exitCode = 1;
    }
    process.removeAllListeners("message");
    if (process.connected) process.disconnect?.();
    // This dedicated child owns no other service. Exit ONLY after all owned
    // worker clients and the active run have settled; no SQL rollback inference.
    process.exit(process.exitCode ? 1 : 0);
  };
  process.once("disconnect", () => void stop());
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  process.on("message", (input: unknown) => {
    if (stopping) return;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).length !== 2 ||
      !Object.hasOwn(input, "v") ||
      !Object.hasOwn(input, "operation") ||
      (input as { v?: unknown }).v !== 1 ||
      (input as { operation?: unknown }).operation !== "security.reconcile.once"
    ) {
      // Invalid operations cannot invoke SQL or select a target. Static reply.
      process.send?.({ v: 1, state: "rejected" }, () => {});
      return;
    }
    void worker.runOnce().then(
      (result) => {
        if (!stopping && process.connected)
          process.send?.({ v: 1, state: "result", result }, () => {});
      },
      () => {
        // A programming/transport failure must not become an unhandled raw error.
        process.exitCode = 1;
        void stop();
      },
    );
  });
  process.stdout.write("Isolated reconciliation child ready.\n");
  process.send({ v: 1, state: "ready" }, (error) => {
    if (error) void stop();
  });
}

void main().catch(() => {
  process.stderr.write("Isolated reconciliation child unavailable.\n");
  process.exitCode = 1;
  if (process.connected) process.disconnect?.();
});
