import { inspect } from "node:util";
import { Pool, type QueryResult } from "pg";
import { createOTP } from "@better-auth/utils/otp";
import { base32 } from "@better-auth/utils/base32";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { assertFoundationUrl } from "../../src/server/security/database-config";
import { ControlFixtures, secretSafe } from "../admission-controls/fixtures";

// ADR020 F-02b: real maintained SDK + owned PG, file-local DRIVER phase fault
// instrumentation only. No SDK/session/verifier replacement or production seam.
// A real fixed SQL error is NOT physical DB-outage evidence. Deletion is an
// attested OFFLINE fixture race, not an operational account/recovery operation.
const fx = new ControlFixtures();
const committedSessionSelect =
  'SELECT id FROM identity."Session" WHERE id=$1 AND "userId"=$2 AND token=$3 AND "expiresAt">$4';
const scenario = (name: string, run: () => Promise<void>) =>
  it(name, () => secretSafe(run));
type DenialRow = {
  id: string;
  occurred_at: string;
  reason: string;
  outcome: string;
};

beforeAll(() => secretSafe(() => fx.start()));
beforeEach(() => secretSafe(() => fx.resetScenario()));
afterAll(() => secretSafe(() => fx.stop()));

async function assertOwnedOfflineFixture(): Promise<void> {
  const migration = new URL(
    assertFoundationUrl(fx.owned.migrationUrl, "migrate"),
  );
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix || migration.pathname !== `/${fx.owned.name}`)
    throw new Error("Post-native fixture binding rejected.");
  const result = await fx.migration.query<{ owned: boolean }>(
    `SELECT current_database()=$1 AND current_user=$2 AND session_user=$2
      AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3
      AND shobj_description(r.oid,'pg_authid')=shobj_description(d.oid,'pg_database') AS owned
     FROM pg_database d JOIN pg_roles r ON r.rolname=$2 WHERE d.datname=$1`,
    [
      fx.owned.name,
      migration.username,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (result.rowCount !== 1 || result.rows[0]?.owned !== true)
    throw new Error("Post-native fixture ownership rejected.");
}

async function denialRows(): Promise<DenialRow[]> {
  return (
    await fx.migration.query<DenialRow>(
      "SELECT id::text,occurred_at::text,reason,outcome FROM audit.denials ORDER BY occurred_at,id",
    )
  ).rows;
}

for (const mode of ["outer-sql-error", "committed-session-delete"] as const) {
  describe("real SDK post-native committed-session recheck terminal denial", () => {
    scenario(
      mode === "outer-sql-error"
        ? "records exactly one unavailable denial for a real SQL fault on the second committed-session lookup"
        : "records exactly one forbidden denial after offline deletion of the first independently committed final SID",
      async () => {
        const principal = await fx.createPrincipal();
        const primary = await fx.begin(principal);
        expect(primary.operation.response.ok).toBe(true);
        const code = await createOTP(base32.decode(principal.secret), {
          period: 30,
          digits: 6,
        }).totp();
        const before = new Set((await denialRows()).map((row) => row.id));
        await assertOwnedOfflineFixture();
        let matched = 0,
          firstLookupCompleted = 0,
          faultOnce = 0,
          deletionOnce = 0,
          secondBindingMatched = false;
        let finalSid: string | undefined;
        const original = Pool.prototype.query;
        // Proxy retains the driver's query overloads. Nonmatching invocations
        // return the EXACT original result synchronously (including callbacks),
        // with original receiver/arguments. Only the literal promise SELECT
        // below is instrumented; no parameters/rows enter diagnostics.
        const observedQuery = new Proxy(original, {
          apply(target, receiver: Pool, args: unknown[]) {
            if (args[0] !== committedSessionSelect)
              return Reflect.apply(target, receiver, args);
            matched += 1;
            const phase = matched;
            return (async () => {
              const parameters: unknown = args[1];
              if (
                !Array.isArray(parameters) ||
                parameters.length !== 4 ||
                typeof parameters[0] !== "string" ||
                typeof parameters[1] !== "string" ||
                parameters[1] !== principal.userId
              )
                throw new Error("Post-native private lookup binding rejected.");
              if (phase === 2 && mode === "outer-sql-error") {
                secondBindingMatched = parameters[0] === finalSid;
                faultOnce += 1;
                // Execute an ACTUAL fixed PG error on the same AUTH pool. This
                // replaces only this final independent visibility query, not
                // maintained password/TOTP/session verification or issuance.
                return Reflect.apply(target, receiver, ["SELECT 1/0"]);
              }
              const result = (await Reflect.apply(
                target,
                receiver,
                args,
              )) as QueryResult<{ id: string }>;
              if (phase === 1) {
                if (
                  result.rowCount !== 1 ||
                  result.rows.length !== 1 ||
                  result.rows[0].id !== parameters[0]
                )
                  throw new Error("Post-native committed lookup unavailable.");
                finalSid = result.rows[0].id;
                firstLookupCompleted += 1;
                if (mode === "committed-session-delete") {
                  // Attestation precedes installing the observer. The same NEW
                  // fixture client deletes only this actual final SID/user; no
                  // broad session deletion, grants, settings or retry follows.
                  const removed = await fx.migration.query(
                    'DELETE FROM identity."Session" WHERE id=$1 AND "userId"=$2',
                    [finalSid, principal.userId],
                  );
                  if (removed.rowCount !== 1)
                    throw new Error("Post-native fixed deletion unavailable.");
                  deletionOnce += 1;
                }
              }
              // Return the real first lookup unchanged even after deletion. The
              // native rawSession already holds the genuine SDK session object;
              // factor/user state is unchanged, so observation can complete.
              return result;
            })();
          },
        });
        const spy = vi
          .spyOn(Pool.prototype, "query")
          .mockImplementation(observedQuery);
        const captures = [
          vi.spyOn(console, "error").mockImplementation(() => {}),
          vi.spyOn(console, "warn").mockImplementation(() => {}),
          vi.spyOn(console, "info").mockImplementation(() => {}),
          vi.spyOn(console, "log").mockImplementation(() => {}),
        ];
        try {
          const operation = await fx.subject.verifyTotp(
            code,
            primary.jar.header,
          );
          // Assert the phase witness BEFORE claiming the desired branch. A
          // dependency/SDK phase change is a real test failure, not a skip or
          // permission to silently select another query/fault point.
          expect(firstLookupCompleted).toBe(1);
          expect(matched).toBe(mode === "outer-sql-error" ? 2 : 1);
          expect(faultOnce).toBe(mode === "outer-sql-error" ? 1 : 0);
          expect(deletionOnce).toBe(
            mode === "committed-session-delete" ? 1 : 0,
          );
          if (mode === "outer-sql-error")
            expect(secondBindingMatched).toBe(true);
          const text = await operation.response.clone().text();
          const expectedReason =
            mode === "outer-sql-error" ? "unavailable" : "forbidden";
          const expectedOutcome =
            mode === "outer-sql-error" ? "unavailable" : "denied";
          const sentinels = [
            principal.userId,
            principal.email,
            principal.password,
            principal.secret,
            principal.generationId,
            fx.secret,
            code,
            primary.jar.header,
            finalSid ?? "",
            ...primary.jar.header
              .split("; ")
              .map((cookie) => cookie.slice(cookie.indexOf("=") + 1)),
          ].filter(Boolean);
          expect(operation.response.status).toBe(
            mode === "outer-sql-error" ? 503 : 403,
          );
          expect(operation.evidenceHandle === null).toBe(true);
          expect(operation.response.headers.getSetCookie().length).toBe(0);
          expect(
            text ===
              JSON.stringify({
                allowed: false,
                reason: expectedReason,
                state: "dormant-denied",
                applicationAdmission: "disabled",
              }) &&
              operation.response.headers.get("cache-control") ===
                "private, no-store" &&
              !operation.response.headers.has("location"),
          ).toBe(true);
          const diagnostics = captures
            .flatMap((capture) => capture.mock.calls)
            .map((args) => inspect(args, { depth: 6 }))
            .join("\n");
          expect(
            sentinels.every(
              (sentinel) =>
                !text.includes(sentinel) && !diagnostics.includes(sentinel),
            ),
          ).toBe(true);
          expect(
            !text.includes("rollback") &&
              !diagnostics.includes("division by zero"),
          ).toBe(true);
          const rows = await denialRows();
          expect(
            [...before].every((id) => rows.some((row) => row.id === id)),
          ).toBe(true);
          const delta = rows.filter((row) => !before.has(row.id));
          expect(delta.length).toBe(1);
          expect(
            delta.every(
              (row) =>
                Object.keys(row).sort().join(",") ===
                  "id,occurred_at,outcome,reason" &&
                row.reason === expectedReason &&
                row.outcome === expectedOutcome &&
                Number.isFinite(Date.parse(row.occurred_at)) &&
                // UUID/time are typed metadata: do not mistake an accidental
                // six-digit substring for an OTP payload. Body/log checks above
                // still include the exact code; all full credentials stay checked.
                sentinels
                  .filter((sentinel) => sentinel !== code)
                  .every((sentinel) => !JSON.stringify(row).includes(sentinel)),
            ),
          ).toBe(true);
          const witness = await fx.migration.query<{ safe: boolean }>(
            `SELECT NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)
              AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1)
              AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1
                AND (evidence_handle IS NOT NULL OR state IN ('ready','consumed')))
              AND NOT EXISTS(SELECT 1 FROM audit.events WHERE subject_id=$1
                AND action IN ('control.evidence','control.login','control.step_up'))
              AND EXISTS(SELECT 1 FROM control_private.attempts a JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
                WHERE a.user_id=$1 AND a.state='inflight' AND a.operation_handle IS NOT NULL
                AND a.evidence_handle IS NULL AND a.reserved_at=b.reserved_at
                AND b.expires_at=b.reserved_at+interval '180 seconds' AND b.expires_at>clock_timestamp())
              AND (SELECT count(*)=2 FROM control_private.budgets WHERE key_mac IN
                (control_private.mac('budget-account-mfa',$1::text),control_private.mac('budget-ip-mfa','unknown')) AND used=1)
              AND EXISTS(SELECT 1 FROM control_private.session_observations WHERE session_id=$2 AND user_id=$1 AND retired=$3)
              AND (EXISTS(SELECT 1 FROM identity."Session" WHERE id=$2 AND "userId"=$1)=$4) AS safe`,
            [
              principal.userId,
              finalSid,
              mode === "committed-session-delete",
              mode === "outer-sql-error",
            ],
          );
          expect(witness.rows.length === 1 && witness.rows[0].safe).toBe(true);
        } finally {
          spy.mockRestore();
          for (const capture of captures) capture.mockRestore();
        }
      },
    );
  });
}
