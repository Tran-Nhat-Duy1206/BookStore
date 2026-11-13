import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  NEXT_AUTH_PATHS,
  NEXT_HOST,
} from "../../experiments/next-security/wire";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";
import {
  createTransportCertificates,
  type TransportCertificateFixture,
} from "../https-transport/certificates";
import {
  NextWireClient,
  nextConfig,
  startNextProcess,
  type NextProcess,
} from "./client";

type AbortResult = {
  aborted: boolean;
  authorized: boolean;
  receivedResponse: boolean;
  receivedCookies: boolean;
};
/** Real CA-validated HTTPS disconnect, not browser trust or supervisor IPC loss.
 * Never absorb or capture a response body/cookie; only fixed boolean witnesses.
 */
function abortableTotp(client: NextWireClient, code: string) {
  let abort = () => {};
  const done = new Promise<AbortResult>((resolve, reject) => {
    let intentional = false,
      authorized = false,
      receivedResponse = false,
      receivedCookies = false;
    const body = JSON.stringify({ code });
    const req = request(
      {
        hostname: NEXT_HOST,
        servername: NEXT_HOST,
        port: client.port,
        path: NEXT_AUTH_PATHS.totp,
        method: "POST",
        ca: client.ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        agent: false,
        timeout: 8000,
        headers: {
          Host: `${NEXT_HOST}:${client.port}`,
          Origin: client.origin,
          "X-Bookstore-CSRF": "1",
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          Connection: "close",
          Cookie: client.jar.header,
        },
        lookup(hostname, options, callback) {
          if (hostname !== NEXT_HOST) {
            callback(new Error("Private DNS rejected."), "", 4);
            return;
          }
          if (options.all)
            callback(null, [{ address: "127.0.0.1", family: 4 }]);
          else callback(null, "127.0.0.1", 4);
        },
      },
      (response) => {
        receivedResponse = true;
        receivedCookies = (response.headers["set-cookie"] ?? []).length > 0;
        response.resume();
      },
    );
    req.once("socket", (socket) =>
      socket.once("secureConnect", () => {
        authorized = "authorized" in socket && socket.authorized === true;
      }),
    );
    req.once("timeout", () => req.destroy());
    req.once("error", () => {
      if (!intentional)
        reject(
          new Error(
            "Synthetic Next abort probe unavailable; details suppressed.",
          ),
        );
    });
    req.once("close", () =>
      resolve({
        aborted: intentional,
        authorized,
        receivedResponse,
        receivedCookies,
      }),
    );
    abort = () => {
      intentional = true;
      req.destroy();
    };
    req.end(body);
  });
  return { abort: () => abort(), done };
}

const fx = new ControlFixtures();
let certs: TransportCertificateFixture | undefined,
  child: NextProcess | undefined;
beforeAll(() =>
  secretSafe(async () => {
    certs = await createTransportCertificates();
    await fx.start();
    child = await startNextProcess(
      nextConfig(fx.config, certs, randomBytes(48).toString("hex"), 3463),
    );
  }),
);
afterAll(() =>
  secretSafe(async () => {
    try {
      await child?.close();
    } finally {
      try {
        await fx.stop();
      } finally {
        await certs?.close();
      }
    }
  }),
);
async function sessions(userId: string): Promise<number> {
  return (
    await fx.migration.query<{ n: number }>(
      'SELECT count(*)::integer n FROM identity."Session" WHERE "userId"=$1',
      [userId],
    )
  ).rows[0].n;
}

it("actual Next HTTPS disconnect after committed native session and blocked evidence retires undelivered lineage", () =>
  secretSafe(async () => {
    if (!certs || !child)
      throw new Error("Owned Next abort fixture unavailable.");
    const principal = await fx.createPrincipal(),
      client = new NextWireClient(certs.ca, 3463);
    const password = await client.post("password", {
      email: principal.email,
      password: principal.password,
    });
    expect(
      password.authorized &&
        password.status === 200 &&
        password.state === "mfa-required",
    ).toBe(true);
    const before = await sessions(principal.userId),
      primaryCookie = client.jar.header;
    const blocker = await fx.client(fx.owned.migrationUrl);
    let locked = false,
      created = false,
      triggered = false;
    let operation: ReturnType<typeof abortableTotp> | undefined,
      settled: Promise<AbortResult | null> | undefined;
    try {
      await fx.migration.query(
        "CREATE FUNCTION public.next_pause_evidence() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN PERFORM pg_catalog.pg_advisory_xact_lock(624320019::bigint); RETURN NEW; END $$",
      );
      created = true;
      await fx.migration.query(
        "REVOKE ALL ON FUNCTION public.next_pause_evidence() FROM PUBLIC",
      );
      await fx.migration.query(
        "CREATE TRIGGER next_pause_evidence BEFORE INSERT ON audit.events FOR EACH ROW WHEN(NEW.action='control.evidence') EXECUTE FUNCTION public.next_pause_evidence()",
      );
      triggered = true;
      await blocker.query("SELECT pg_advisory_lock(624320019::bigint)");
      locked = true;
      const pid = (
        await blocker.query<{ pid: number }>("SELECT pg_backend_pid() pid")
      ).rows[0].pid;
      const code = await fx.code(principal);
      operation = abortableTotp(client, code);
      settled = operation.done.then(
        (result) => result,
        () => null,
      );
      let observed = false;
      const until = performance.now() + 5000;
      for (let turn = 0; turn < 2000 && performance.now() < until; turn++) {
        const row = await fx.migration.query<{ blocked: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND usename=$2 AND $1::integer=ANY(pg_blocking_pids(pid))) blocked",
          [pid, new URL(fx.owned.verifierUrl).username],
        );
        if (row.rows[0]?.blocked) {
          observed = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(observed).toBe(true);
      expect((await sessions(principal.userId)) > before).toBe(true);
      const burn = (
        await fx.migration.query<{ expires: string; live: boolean }>(
          `SELECT b.expires_at::text expires,b.expires_at>clock_timestamp() live
       FROM control_private.attempts a JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
       WHERE a.user_id=$1 AND a.purpose='login' ORDER BY a.authenticated_at DESC LIMIT 1`,
          [principal.userId],
        )
      ).rows[0];
      expect(typeof burn?.expires === "string" && burn.live).toBe(true);
      if (!burn) throw new Error("Owned replay witness unavailable.");
      operation.abort();
      const disconnected = await settled;
      expect(
        disconnected !== null &&
          disconnected.aborted &&
          disconnected.authorized &&
          !disconnected.receivedResponse &&
          !disconnected.receivedCookies,
      ).toBe(true);
      expect(client.jar.header === primaryCookie).toBe(true);
      await blocker.query("SELECT pg_advisory_unlock(624320019::bigint)");
      locked = false;
      // The native SDK transaction already committed. This is deny-only cleanup,
      // never a claim that abort rolled the provider mutation back.
      let retired = false;
      const deadline = performance.now() + 5000;
      for (let turn = 0; turn < 2000 && performance.now() < deadline; turn++) {
        const row = await fx.migration.query<{ safe: boolean }>(
          `SELECT a.state='revoked' AND a.final_session_id IS NOT NULL
         AND NOT EXISTS(SELECT 1 FROM staff.admissions s WHERE s.user_id=a.user_id)
         AND NOT EXISTS(SELECT 1 FROM control_private.session_controls c WHERE c.user_id=a.user_id)
         AND NOT EXISTS(SELECT 1 FROM audit.events e WHERE e.subject_id=a.user_id AND e.action='control.login')
         AND NOT EXISTS(SELECT 1 FROM identity."Session" s WHERE s.id=a.final_session_id)
         AND EXISTS(SELECT 1 FROM control_private.replay_burns b WHERE b.code_mac=a.code_mac AND b.expires_at>clock_timestamp() AND b.expires_at::text=$2) safe
         FROM control_private.attempts a WHERE a.user_id=$1 AND a.purpose='login' ORDER BY a.authenticated_at DESC LIMIT 1`,
          [principal.userId, burn.expires],
        );
        if (row.rows[0]?.safe) {
          retired = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(retired).toBe(true);
      const afterAbort = await sessions(principal.userId);
      const replay = await client.post(
        "totp",
        { code },
        { cookie: primaryCookie },
      );
      expect(
        replay.authorized &&
          replay.status !== 200 &&
          replay.disabled &&
          replay.cookies.length === 0,
      ).toBe(true);
      expect((await sessions(principal.userId)) === afterAbort).toBe(true);
      const noAdmission = (
        await fx.migration.query<{ safe: boolean }>(
          "SELECT NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1) AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1) AS safe",
          [principal.userId],
        )
      ).rows[0]?.safe;
      expect(noAdmission === true).toBe(true);
    } finally {
      operation?.abort();
      try {
        if (locked)
          await blocker.query("SELECT pg_advisory_unlock(624320019::bigint)");
        if (settled) await settled;
      } finally {
        try {
          if (triggered)
            await fx.migration.query(
              "DROP TRIGGER next_pause_evidence ON audit.events",
            );
          if (created)
            await fx.migration.query(
              "DROP FUNCTION public.next_pause_evidence()",
            );
        } finally {
          await fx.release(blocker);
        }
      }
    }
  }));
