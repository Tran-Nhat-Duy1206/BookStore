import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ReconciliationResult } from "../../src/server/security/reconciliation-worker";
import { assertFoundationUrl } from "../../src/server/security/database-config";

const counts = [
  "selected",
  "applied",
  "skipped",
  "failed",
  "uncertain",
  "failureRecordCallsConfirmed",
] as const;
const states = ["completed", "partial", "unavailable", "deadline", "busy"];

function resultFrom(value: unknown): ReconciliationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 7 ||
    !states.includes(record.status as string) ||
    counts.some(
      (name) =>
        typeof record[name] !== "number" ||
        !Number.isSafeInteger(record[name]) ||
        (record[name] as number) < 0 ||
        (record[name] as number) > 20,
    )
  )
    return null;
  return Object.freeze({
    status: record.status as ReconciliationResult["status"],
    selected: record.selected as number,
    applied: record.applied as number,
    skipped: record.skipped as number,
    failed: record.failed as number,
    uncertain: record.uncertain as number,
    failureRecordCallsConfirmed: record.failureRecordCallsConfirmed as number,
  });
}

/** Real owned child for isolated tests, not an HTTP/scheduler API. No parent env
 * spread: AUTH/STAFF/VERIFIER/migrate/bootstrap/SDK/TLS secrets cannot transfer.
 * Configuration is private IPC-process environment, never argv or a file.
 */
export async function createWorkerProcess(workerUrl: string) {
  assertFoundationUrl(workerUrl, "worker");
  const environment: NodeJS.ProcessEnv = { NODE_ENV: "production" };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "SystemDrive",
    "ComSpec",
    "PATHEXT",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.BOOKSTORE_ISOLATED_NEXT_TEST = "1";
  environment.BOOKSTORE_RECONCILIATION_CONFIG = JSON.stringify({ workerUrl });
  const child: ChildProcess = fork(
    fileURLToPath(
      new URL("../../scripts/reconciliation-worker.ts", import.meta.url),
    ),
    [],
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      execArgv: ["--conditions=react-server", "--import", "tsx"],
      env: environment,
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      serialization: "json",
    },
  );
  let exited = false;
  let closing: Promise<void> | undefined;
  let inFlight = false;
  let pending:
    | {
        resolve: (value: unknown) => void;
        reject: (reason: Error) => void;
      }
    | undefined;
  let readyResolve!: () => void;
  let readyReject!: (reason: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  let exitResolve!: () => void;
  const exit = new Promise<void>((resolve) => {
    exitResolve = resolve;
  });
  const unavailable = () =>
    new Error("Isolated reconciliation child unavailable.");
  child.on("message", (message: unknown) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      pending?.reject(unavailable());
      return;
    }
    const envelope = message as Record<string, unknown>;
    if (envelope.v !== 1) {
      pending?.reject(unavailable());
      return;
    }
    if (envelope.state === "ready" && Object.keys(envelope).length === 2) {
      readyResolve();
    } else {
      pending?.resolve(envelope);
    }
  });
  child.once("error", () => {
    readyReject(unavailable());
    pending?.reject(unavailable());
  });
  const onExit = () => {
    if (exited) return;
    exited = true;
    readyReject(unavailable());
    pending?.reject(unavailable());
    exitResolve();
  };
  // Inherited stdio has no private stream to drain. IPC disconnect can leave
  // 'close' unobserved; 'exit' is the actual owned-process termination witness.
  // Also observe close for a spawn failure that never emits exit.
  child.once("exit", onExit);
  child.once("close", onExit);
  async function stop(force: boolean): Promise<void> {
    if (!closing) {
      closing = (async () => {
        if (exited) return;
        if (force) child.kill("SIGKILL");
        else if (child.connected) child.disconnect();
        else child.kill("SIGTERM");
        const timer = setTimeout(() => {
          if (!exited) child.kill("SIGKILL");
        }, 5_000);
        try {
          await exit;
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    return closing;
  }
  const startupTimer = setTimeout(() => {
    readyReject(unavailable());
    void stop(true);
  }, 15_000);
  try {
    await ready;
  } catch {
    await stop(true);
    throw unavailable();
  } finally {
    clearTimeout(startupTimer);
  }

  async function request(operation: object): Promise<Record<string, unknown>> {
    if (exited || closing || inFlight) throw unavailable();
    inFlight = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        pending = {
          resolve: (value) => resolve(value as Record<string, unknown>),
          reject,
        };
        timer = setTimeout(() => {
          reject(unavailable());
          void stop(true);
        }, 20_000);
        child.send(operation, (error) => {
          if (error) reject(unavailable());
        });
      });
    } finally {
      clearTimeout(timer);
      pending = undefined;
      inFlight = false;
    }
  }

  return Object.freeze({
    async runOnce(): Promise<ReconciliationResult> {
      const envelope = await request({
        v: 1,
        operation: "security.reconcile.once",
      });
      const result = resultFrom(envelope.result);
      if (
        Object.keys(envelope).length !== 3 ||
        envelope.state !== "result" ||
        !result
      )
        throw unavailable();
      return result;
    },
    /** Fixed negative fixture: extra selectors must be rejected before SQL. */
    async rejectTargetSelector(): Promise<boolean> {
      const envelope = await request({
        v: 1,
        operation: "security.reconcile.once",
        targetUserId: "synthetic-forbidden-selector",
      });
      return (
        Object.keys(envelope).length === 2 && envelope.state === "rejected"
      );
    },
    close: () => stop(false),
    kill: () => stop(true),
  });
}

export type WorkerProcess = Awaited<ReturnType<typeof createWorkerProcess>>;
