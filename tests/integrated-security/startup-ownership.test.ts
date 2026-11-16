import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { NextSecurityConfig } from "../../experiments/next-security/runtime/context";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  nextConfig,
  NextWireClient,
  startNextProcess,
  type NextProcess,
} from "../next-security/client";

// ADR020 startup ownership: actual owned child IPC loss at the earliest parent
// spawn event, BEFORE any successful service publication/readiness is permitted.
// No production hooks, fake bootstrap request, authority callback or altered SDK.
// This is Node CA-validated HTTPS evidence, not Chromium/NSS browser evidence.
const root = fileURLToPath(new URL("../../", import.meta.url));
const port = 3463;
const fx = new ControlFixtures();
let certs: TransportCertificateFixture;
let fresh: NextProcess | undefined;

function minimalRuntimeEnvironment(
  config: NextSecurityConfig,
): NodeJS.ProcessEnv {
  // Exact existing startNextProcess allowlist. No inherited bootstrap/Migrate,
  // worker, test DB URL, PG*, proxy, NODE_OPTIONS, provider or TLS environment.
  // Explicit config has only the same existing AUTH/STAFF/VERIFIER test purposes.
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    BOOKSTORE_ISOLATED_NEXT_TEST: "1",
    BOOKSTORE_NEXT_SECURITY_CONFIG: JSON.stringify(config),
    NEXT_TELEMETRY_DISABLED: "1",
  };
  for (const name of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "HOME",
    "USERPROFILE",
    "ComSpec",
    "PATHEXT",
  ])
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  return environment;
}
async function assertExclusivePortFree(): Promise<void> {
  // Only our just-created probe is closed. EADDRINUSE is a fixed failure, never
  // permission to inspect/adopt/terminate another listener or select another port.
  await new Promise<void>((done, failed) => {
    const probe = createServer();
    probe.once("error", () =>
      failed(new Error("Owned startup port unavailable.")),
    );
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) =>
        error
          ? failed(new Error("Owned startup port cleanup unavailable."))
          : done(),
      );
    });
  });
}

async function loseSupervisorAtSpawn(config: NextSecurityConfig) {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "experiments/next-security/server.ts"],
    {
      cwd: root,
      env: minimalRuntimeEnvironment(config),
      // Installed esbuild0.28.2 main.js:2272–2308 inherits stderr in an
      // unreferenced loader helper. Do not make that inherited Windows pipe an
      // ownership oracle. Keep stdout fully drained for publication/readiness,
      // IPC loss, natural exit/close and genuine same-port restart assertions.
      // This startup case makes NO stderr/log-leakage acceptance claim.
      stdio: ["ignore", "pipe", "ignore", "ipc"],
    },
  );
  let spawned = false;
  let disconnectedAtSpawn = false;
  let disconnectFailed = false;
  let spawnError = false;
  let exited = false;
  let closed = false;
  let stdoutClosed = false;
  let ipcDisconnected = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let forcedCleanup = false;
  let cleanupSignalFailed = false;
  const flags = {
    configValidated: false,
    manifestValidated: false,
    published: false,
    preparing: false,
    prepared: false,
    ready: false,
  };
  let privateTail = "";
  child.stdout?.on("data", (chunk) => {
    // Private bounded parser only. Neither this buffer nor unknown child output
    // is printed, asserted, thrown, written to a file or returned to the caller.
    privateTail = (privateTail + chunk.toString("utf8")).slice(-8192);
    flags.configValidated ||= privateTail.includes(
      "BookStore Next startup config validated.",
    );
    flags.manifestValidated ||= privateTail.includes(
      "BookStore Next startup manifest validated.",
    );
    flags.published ||= privateTail.includes(
      "BookStore Next startup service published.",
    );
    flags.preparing ||= privateTail.includes(
      "BookStore Next startup preparing framework.",
    );
    flags.prepared ||= privateTail.includes(
      "BookStore Next startup framework prepared.",
    );
    flags.ready ||= privateTail.includes(
      "BookStore isolated Next security ready.",
    );
  });
  child.once("error", () => {
    spawnError = true;
  });
  child.once("spawn", () => {
    spawned = true;
    // Disconnect INSIDE the actual spawn callback, not after awaiting readiness,
    // a stage banner, a timer, a parent handshake or any HTTP request.
    try {
      if (child.connected) {
        child.disconnect();
        disconnectedAtSpawn = true;
      } else {
        disconnectFailed = true;
      }
    } catch {
      disconnectFailed = true;
    }
  });
  const actualExit = new Promise<void>((done) => {
    child.once("exit", (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      done();
    });
  });
  child.once("close", () => {
    closed = true;
  });
  // Windows Node24 can miss ChildProcess.close bookkeeping when IPC is
  // disconnected inside spawn: a credential-free node -e probe naturally exited
  // 0 with stdout ended/closed and IPC off, but _closesNeeded=3/_closesGot=2.
  // Require the ACTUAL resources instead, not that composite event: natural
  // exit, fully drained stdout close, and natural IPC release within SAME45s.
  const stdoutDrained = new Promise<void>((done) => {
    if (!child.stdout) return done();
    child.stdout.once("close", () => {
      stdoutClosed = true;
      done();
    });
  });
  const ipcReleased = new Promise<void>((done) => {
    const released = () => {
      ipcDisconnected = true;
      done();
    };
    if (!child.connected) released();
    else child.once("disconnect", released);
  });
  const ownedShutdown = Promise.all([
    actualExit,
    stdoutDrained,
    ipcReleased,
  ]).then(() => {});
  const diagnostic = (
    phase:
      "startup-bound" | "cleanup-exit-bound" | "cleanup-close-bound" | "result",
  ) =>
    console.info(
      `Synthetic early IPC diagnostic phase=${phase}, spawned=${spawned}, disconnected=${disconnectedAtSpawn}, exited=${exited}, closed=${closed}, stdoutClosed=${stdoutClosed}, stdoutEnded=${child.stdout?.readableEnded === true}, ipcDisconnected=${ipcDisconnected}, exitZero=${exitCode === 0}, forced=${forcedCleanup}, signalFailed=${cleanupSignalFailed}, config=${flags.configValidated}, manifest=${flags.manifestValidated}, publication=${flags.published}, preparing=${flags.preparing}, prepared=${flags.prepared}, ready=${flags.ready}, stderrCapture=disabled-not-log-evidence.`,
    );
  // These resolving-only promises have handlers from creation. Keep actual exit
  // separate from close: on Windows loader descendants can retain inherited
  // stdout/stderr AFTER the owned main process exited. That is not permission to
  // wait forever, kill a descendant/global process, or certify natural cleanup.
  async function bounded(pending: Promise<void>, millis: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        pending.then(() => true),
        new Promise<boolean>((done) => {
          timer = setTimeout(() => done(false), millis);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  let failedCleanup: Promise<void> | undefined;
  const cleanupFailureOnly = () =>
    (failedCleanup ??= (async () => {
      // The entire failure branch stays a failure, including a natural main exit
      // whose inherited pipes did not close. Forced stream cleanup cannot pass.
      forcedCleanup = true;
      if (!exited && !closed) {
        try {
          child.kill("SIGKILL");
        } catch {
          cleanupSignalFailed = true;
        }
      }
      if (!exited && !closed && !(await bounded(actualExit, 5_000)))
        diagnostic("cleanup-exit-bound");
      // ONLY this parent's owned pipe endpoints, never another process/listener.
      // Install failure-only redacted error handlers before destroying endpoints.
      child.stdout?.once("error", () => {});
      child.stderr?.once("error", () => {});
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (child.connected) {
        try {
          child.disconnect();
        } catch {
          disconnectFailed = true;
        }
      }
      if (!stdoutClosed && !(await bounded(stdoutDrained, 5_000)))
        diagnostic("cleanup-close-bound");
    })());
  try {
    // SAME45s success/startup bound, with no retries or increase to the existing
    // 90s test budget. The two5s waits above are FAILURE cleanup only.
    const withinStartupBound = await bounded(ownedShutdown, 45_000);
    if (!withinStartupBound) {
      // Emit fixed evidence BEFORE kill/stream teardown: distinguish a published
      // live orphan from natural exit with only a retained pipe close artifact.
      diagnostic("startup-bound");
      await cleanupFailureOnly();
    }
  } finally {
    if (!exited || !stdoutClosed || !ipcDisconnected)
      await cleanupFailureOnly();
    privateTail = "";
  }
  const clean =
    spawned &&
    disconnectedAtSpawn &&
    !disconnectFailed &&
    !spawnError &&
    exited &&
    stdoutClosed &&
    child.stdout?.readableEnded === true &&
    ipcDisconnected &&
    !child.connected &&
    exitCode === 0 &&
    exitSignal === null &&
    !forcedCleanup &&
    !flags.published &&
    !flags.preparing &&
    !flags.prepared &&
    !flags.ready;
  if (!clean) diagnostic("result");
  return clean;
}

beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
  }),
);
afterAll(() =>
  secretSafe(async () => {
    try {
      await fresh?.close();
      await fx.stop();
    } finally {
      await certs?.close();
    }
  }),
);

it("actual supervisor IPC loss inside child spawn permits no publication/listen and a genuine same-port Next restart", () =>
  secretSafe(async () => {
    const config = nextConfig(
      fx.config,
      certs,
      randomBytes(48).toString("base64url"),
    );
    await assertExclusivePortFree();
    const stoppedBeforePublication = await loseSupervisorAtSpawn(config);
    // Force-kill is failure cleanup, NEVER counted as successful ownership exit.
    expect(stoppedBeforePublication).toBe(true);
    await assertExclusivePortFree();
    fresh = await startNextProcess(config);
    const response = await new NextWireClient(certs.ca).page();
    expect(
      response.authorized &&
        response.status === 200 &&
        response.noStore &&
        !response.location &&
        response.cookies.length === 0 &&
        response.body.includes('data-live-guard="denied-test-session"') &&
        response.body.includes('data-application-admission="disabled"'),
    ).toBe(true);
    const diagnostic = await fresh.diagnostics();
    expect(
      diagnostic.servicePublications === 1 &&
        diagnostic.outgoingHttpRequests === 0 &&
        diagnostic.ingressRequests === 1 &&
        diagnostic.tlsErrors === 0,
    ).toBe(true);
    await fresh.close();
    fresh = undefined;
    await assertExclusivePortFree();
  }));
