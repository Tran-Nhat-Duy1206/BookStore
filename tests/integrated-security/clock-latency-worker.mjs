// Test-only, non-authorizing latency attribution. Both control and actual are
// classified harness metadata, NOT outcomes of a private authority Promise or
// MFA proofs. Public Query end is client-processed ReadyForQuery-associated;
// it is NOT wire arrival, server-send time, or SQL-only execution time.
// The parent owns any governance hold, the cold child's minimal environment,
// and the 45-second failure deadline. This worker has no retries/time injection.
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";

const environmentConfig = process.env.BOOKSTORE_CLOCK_LATENCY_CONFIG;
delete process.env.BOOKSTORE_CLOCK_LATENCY_CONFIG;
const threaded = !isMainThread && parentPort !== null;
const roles = ["verifier", "staff"];
const modes = ["idle", "node-only", "db-only", "combined"];
let role = null;
let mode = null;
let shared = null;
let client;
let closed = false;
let stage = "config";
let protocolFailed = false;
let clientFailed = false;
let rejectPending;
let runSeen = false;
let detach = () => {};

function exactPlain(value, keys) {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const own = Reflect.ownKeys(value);
  return (
    own.length === keys.length &&
    own.every(
      (key) =>
        typeof key === "string" &&
        keys.includes(key) &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"),
    )
  );
}

function send(message) {
  if (threaded) parentPort.postMessage(message);
  else {
    if (!process.connected || typeof process.send !== "function")
      throw new Error();
    process.send(message);
  }
}

function disconnect() {
  detach();
  if (threaded) parentPort.close();
  else if (process.connected) process.disconnect();
}

// Never export raw values, exception messages, configuration, or backend PID.
async function main() {
  let summary;
  try {
    const config = threaded ? workerData : JSON.parse(environmentConfig);
    if (
      !exactPlain(
        config,
        threaded
          ? ["v", "url", "role", "mode", "shared"]
          : ["v", "url", "role", "mode"],
      ) ||
      config.v !== 1 ||
      !roles.includes(config.role) ||
      !modes.includes(config.mode) ||
      typeof config.url !== "string"
    )
      throw new Error();
    role = config.role;
    mode = config.mode;
    if (threaded) {
      if (
        !(config.shared instanceof SharedArrayBuffer) ||
        config.shared.byteLength !== 32
      )
        throw new Error();
      shared = new Int32Array(config.shared);
      // Parent supplies fresh storage; do not overwrite an adopted experiment.
      if (Array.from(shared).some((value) => value !== 0)) throw new Error();
    } else if (typeof process.send !== "function" || !process.connected) {
      throw new Error();
    }

    stage = "import";
    // Native Node 24 leaf-TypeScript imports: no loader or production edits.
    const { assertFoundationUrl } =
      await import("../../src/server/security/database-config.ts");
    const { validateControlClockSample } =
      await import("../../src/server/security/control-clock.ts");
    const { default: pg } = await import("pg");
    stage = "config";
    const url = assertFoundationUrl(config.url, role);
    // Regression witness for the purpose-only child environment. Do not echo keys/values.
    const environmentClean = !Object.keys(process.env).some((key) =>
      /DATABASE_URL|^PG(?:PASSWORD|USER|HOST|PORT|DATABASE|OPTIONS)$|^NODE_OPTIONS$/i.test(
        key,
      ),
    );
    if (!environmentClean) throw new Error();
    if (shared) Atomics.store(shared, 4, 1);
    client = new pg.Client({
      connectionString: url,
      // Nonempty USERSET options, as in existing purpose pools: no PGOPTIONS fallback.
      options: "-c application_name=bookstore-clock-latency-diagnostic",
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
    });
    // Public error events must not become uncaught errors containing secrets.
    client.on("error", () => {
      clientFailed = true;
      if (rejectPending) rejectPending(new Error());
    });
    stage = "connect";
    const connectStart = performance.now();
    await client.connect();
    const connectElapsed = performance.now() - connectStart;
    stage = "preflight";
    const preflightStart = performance.now();
    const preflight = await client.query("SELECT pg_backend_pid() AS pid");
    const preflightElapsed = performance.now() - preflightStart;
    const pid = preflight.rows[0]?.pid;
    if (
      preflight.rowCount !== 1 ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      pid > 2147483647 ||
      clientFailed
    )
      throw new Error();
    if (shared) Atomics.store(shared, 0, pid);

    stage = "protocol";
    let resolveRun;
    const run = new Promise((resolve, reject) => {
      resolveRun = resolve;
      rejectPending = reject;
    });
    // Keep rejection handled even if sending ready itself fails first.
    void run.catch(() => {});
    const onMessage = (message) => {
      if (
        runSeen ||
        !exactPlain(message, ["v", "operation"]) ||
        message.v !== 1 ||
        message.operation !== "run"
      ) {
        protocolFailed = true;
        if (rejectPending) rejectPending(new Error());
        return;
      }
      runSeen = true;
      resolveRun();
    };
    const onDisconnect = () => {
      protocolFailed = true;
      if (rejectPending) rejectPending(new Error());
    };
    if (threaded) {
      parentPort.on("message", onMessage);
      parentPort.on("close", onDisconnect);
      detach = () => {
        parentPort.off("message", onMessage);
        parentPort.off("close", onDisconnect);
      };
    } else {
      process.on("message", onMessage);
      process.on("disconnect", onDisconnect);
      detach = () => {
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
      };
    }
    send({ v: 1, operation: "ready", role, mode });
    await run;
    if (protocolFailed || clientFailed) throw new Error();

    stage = "query";
    let response;
    let firstRow;
    let callbackAt;
    let endAt;
    let endWall;
    let apiReturn;
    let callbackSucceeded = false;
    let autocommitIdleAtEnd = false;
    let busyRan = false;
    let rowsSeen = 0;
    let sequence = 0;
    let rowOrder;
    let callbackOrder;
    let endOrder;
    let returnOrder;
    let resolveProbe;
    // This is a HARNESS-owned Promise. query(Query) itself returns Query.
    const probe = new Promise((resolve, reject) => {
      resolveProbe = resolve;
      rejectPending = reject;
    });
    // A synchronous query/send failure can precede the await; do not leave
    // a later public callback rejection unhandled or expose its raw error.
    void probe.catch(() => {});
    const query = new pg.Query(
      {
        text:
          role === "verifier"
            ? "SELECT control_private.clock_probe() AS decision"
            : "SELECT staff.control_clock_probe() AS decision",
      },
      (error, result) => {
        callbackAt = performance.now();
        callbackOrder = ++sequence;
        if (error) rejectPending(new Error());
        else {
          callbackSucceeded = true;
          resolveProbe(result);
        }
      },
    );
    query.on("row", () => {
      if (rowsSeen === 0) {
        firstRow = performance.now();
        rowOrder = ++sequence;
      }
      rowsSeen += 1;
    });
    query.on("error", () => rejectPending(new Error()));
    query.on("end", () => {
      // Capture the control endpoint BEFORE even the idle witness or busy tail.
      endAt = performance.now();
      endWall = Date.now();
      endOrder = ++sequence;
      try {
        autocommitIdleAtEnd = client.getTransactionStatus() === "I";
        if (
          callbackSucceeded &&
          !busyRan &&
          (mode === "node-only" || mode === "combined")
        ) {
          busyRan = true;
          if (shared) Atomics.store(shared, 1, 1);
          try {
            send({ v: 1, operation: "busy-start", role, mode });
            const busyStart = performance.now();
            while (performance.now() - busyStart < 350) {
              // One synchronous listener-tail delay; no SQL/DB lock is held
              // deliberately by this worker. Parent alone owns DB-hold arms.
            }
          } finally {
            if (shared) Atomics.store(shared, 1, 0);
          }
        }
      } catch {
        clientFailed = true;
        rejectPending(new Error());
      }
    });

    // Original production bracket order. API entry/return measures public call
    // cost only: actual driver submission is deliberately NOT observed.
    const before = Date.now();
    const start = performance.now();
    client.query(query);
    apiReturn = performance.now();
    returnOrder = ++sequence;
    send({ v: 1, operation: "query-called", role, mode });
    response = await probe;
    const continuation = performance.now();
    const after = Date.now();
    const continuationOrder = ++sequence;
    rejectPending = undefined;
    if (protocolFailed || clientFailed) throw new Error();

    stage = "decision";
    const decision = response.rows[0]?.decision;
    if (
      response.rowCount !== 1 ||
      rowsSeen !== 1 ||
      !decision ||
      decision.allowed !== true ||
      decision.reason !== "allowed" ||
      typeof decision.databaseTime !== "string" ||
      !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.test(
        decision.databaseTime,
      ) ||
      endAt === undefined ||
      callbackAt === undefined ||
      firstRow === undefined
    ) {
      throw new Error();
    }
    const databaseMs = Date.parse(decision.databaseTime);
    if (!Number.isFinite(databaseMs) || databaseMs < 0) throw new Error();
    const databaseTime = new Date(databaseMs).toISOString();
    const fraction = /\.(\d{4,6})(?:Z|[+-](?:0\d|1\d|2[0-3]):[0-5]\d)$/.exec(
      decision.databaseTime,
    )?.[1];
    // Identical authority precision rule: +1ms PER endpoint iff truncated
    // microseconds have a nonzero sub-millisecond component.
    const pad = fraction && /[1-9]/.test(fraction.slice(3)) ? 1 : 0;
    let capped = false;
    const bounded = (value) => {
      if (!Number.isFinite(value)) {
        capped = true;
        return 60000;
      }
      if (value < 0 || value > 60000) capped = true;
      return Math.min(60000, Math.max(0, value));
    };
    const classify = (wall, mono) => {
      const elapsed = mono - start;
      const adjusted = wall + pad - (before - pad);
      const quality = validateControlClockSample({
        nodeBeforeMs: before - pad,
        nodeAfterMs: wall + pad,
        monotonicElapsedMs: elapsed,
        databaseTime,
      });
      return {
        rawWallSpanMs: bounded(wall - before),
        adjustedWallSpanMs: bounded(adjusted),
        monoElapsedMs: bounded(elapsed),
        precisionPadMs: pad,
        wallExceeded: adjusted > 250,
        monoExceeded: elapsed > 250,
        quality: quality.reason,
      };
    };
    const control = classify(endWall, endAt);
    const actual = classify(after, continuation);
    summary = {
      v: 1,
      operation: "result",
      role,
      mode,
      ok: true,
      closed: false,
      submissionObserved: false,
      readySignal: "public-query-end",
      readyObserved: endAt !== undefined,
      autocommitIdleAtEnd,
      connectMs: bounded(connectElapsed),
      preflightMs: bounded(preflightElapsed),
      queryApiMs: bounded(apiReturn - start),
      callToRowMs: bounded(firstRow - start),
      callToCallbackMs: bounded(callbackAt - start),
      callToEndMs: bounded(endAt - start),
      callToContinuationMs: bounded(continuation - start),
      endToContinuationMs: bounded(continuation - endAt),
      settledToContinuationMs: bounded(continuation - callbackAt),
      rowCount: 1,
      callbackBeforeEnd: callbackOrder < endOrder,
      endBeforeContinuation: endOrder < continuationOrder,
      apiReturnBeforeRow: returnOrder < rowOrder,
      busyRan,
      control,
      actual,
      capped,
    };
  } catch {
    summary = {
      v: 1,
      operation: "error",
      role,
      mode,
      ok: false,
      closed: false,
      stage,
    };
  } finally {
    rejectPending = undefined;
    if (shared) Atomics.store(shared, 1, 0);
    if (client) {
      try {
        await client.end();
        closed = true;
        if (shared) Atomics.store(shared, 2, 1);
      } catch {
        summary = {
          v: 1,
          operation: "error",
          role,
          mode,
          ok: false,
          closed: false,
          stage: "cleanup",
        };
      }
    }
    if (protocolFailed && summary?.ok) {
      summary = {
        v: 1,
        operation: "error",
        role,
        mode,
        ok: false,
        closed,
        stage: "protocol",
      };
    } else if (clientFailed && summary?.ok) {
      summary = {
        v: 1,
        operation: "error",
        role,
        mode,
        ok: false,
        closed,
        stage: "query",
      };
    }
    summary.closed = closed;
    try {
      if (threaded) send(summary);
      else if (process.connected && typeof process.send === "function")
        await new Promise((resolve) => process.send(summary, () => resolve()));
    } catch {
      /* Parent detects missing fixed result. */
    }
    disconnect(); // Natural thread/process completion; never process.exit().
  }
}

// All failures are projected above; do not print an error/configuration/stack.
await main();
