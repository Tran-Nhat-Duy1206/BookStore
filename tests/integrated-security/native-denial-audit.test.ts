import { inspect } from "node:util";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { DormantControlOperation } from "../../src/server/security/provider-proof";
import {
  ControlFixtures,
  secretSafe,
  type SyntheticPrincipal,
} from "../admission-controls/fixtures";

// ADR020 F-02: real maintained SDK + canonical facade + owned disposable PG.
// This suite is intentionally added BEFORE the narrow production correction.
// Preparation/reservation success audits are NOT terminal native denial outcomes.
// No mock verifier, replacement SDK, caller clock, positive issuer or new grant.
const fx = new ControlFixtures();
const scenario = (name: string, work: () => Promise<void>) =>
  it(name, () => secretSafe(work));
const faultText = "Synthetic B2e native denial persistence fault";
type Denial = {
  id: string;
  occurred_at: string;
  reason: string;
  outcome: string;
};
type DenialSnapshot = ReadonlySet<string>;

async function denialRows(): Promise<Denial[]> {
  // IDs stay private in memory. Assertions below expose ONLY booleans/counts.
  return (
    await fx.migration.query<Denial>(
      "SELECT id::text,occurred_at::text,reason,outcome FROM audit.denials ORDER BY occurred_at,id",
    )
  ).rows;
}
async function snapshotDenials(): Promise<DenialSnapshot> {
  return new Set((await denialRows()).map((row) => row.id));
}
async function newDenials(before: DenialSnapshot): Promise<Denial[]> {
  const rows = await denialRows();
  // Recording this outcome cannot erase a previously committed denial.
  expect([...before].every((id) => rows.some((row) => row.id === id))).toBe(
    true,
  );
  return rows.filter((row) => !before.has(row.id));
}
function privateSentinels(principal: SyntheticPrincipal, cookie = "") {
  return [
    principal.email,
    principal.password,
    principal.secret,
    principal.userId,
    principal.generationId,
    fx.secret,
    cookie,
    ...cookie.split("; ").map((item) => item.slice(item.indexOf("=") + 1)),
  ].filter(Boolean);
}
async function expectOneOutcome(
  before: DenialSnapshot,
  reason: "forbidden" | "unavailable",
  outcome: "denied" | "unavailable",
  sentinels: readonly string[],
) {
  const rows = await newDenials(before);
  expect(rows.length).toBe(1);
  expect(
    rows.every(
      (row) =>
        Object.keys(row).sort().join(",") === "id,occurred_at,outcome,reason" &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          row.id,
        ) &&
        Number.isFinite(Date.parse(row.occurred_at)) &&
        row.reason === reason &&
        row.outcome === outcome &&
        !sentinels.some((value) => JSON.stringify(row).includes(value)) &&
        !JSON.stringify(row).includes(faultText),
    ),
  ).toBe(true);
}

async function observeRedactedFailure(
  work: () => Promise<DormantControlOperation>,
  status: 403 | 503,
  sentinels: readonly string[],
): Promise<void> {
  // Capture privately rather than allowing a regression to print raw SDK/SQL
  // diagnostics into JUnit. No captured arguments are assertion operands.
  const captures = [
    vi.spyOn(console, "error").mockImplementation(() => {}),
    vi.spyOn(console, "warn").mockImplementation(() => {}),
    vi.spyOn(console, "info").mockImplementation(() => {}),
    vi.spyOn(console, "log").mockImplementation(() => {}),
  ];
  try {
    const failed = await work();
    const text = await failed.response.clone().text();
    const value: unknown = JSON.parse(text);
    const reason = status === 503 ? "unavailable" : "forbidden";
    expect(failed.response.status).toBe(status);
    expect(failed.evidenceHandle === null).toBe(true);
    expect(failed.response.headers.getSetCookie().length).toBe(0);
    expect(
      failed.response.headers.get("cache-control") === "private, no-store" &&
        !failed.response.headers.has("location") &&
        JSON.stringify(value) ===
          JSON.stringify({
            allowed: false,
            reason,
            state: "dormant-denied",
            applicationAdmission: "disabled",
          }),
    ).toBe(true);
    const diagnostics = captures
      .flatMap((capture) => capture.mock.calls)
      .map((args) => inspect(args, { depth: 6 }))
      .join("\n");
    expect(
      [...sentinels, faultText].every(
        (value) => !text.includes(value) && !diagnostics.includes(value),
      ),
    ).toBe(true);
    // The facade cannot classify an opaque native failure as provider rollback.
    expect(
      !text.includes("rolled_back") &&
        !text.includes("rolledBack") &&
        !text.includes("rollback"),
    ).toBe(true);
  } finally {
    for (const capture of captures) capture.mockRestore();
  }
}

async function expectNoGrant(principal: SyntheticPrincipal): Promise<void> {
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT NOT EXISTS(SELECT 1 FROM staff.admissions WHERE user_id=$1)
      AND NOT EXISTS(SELECT 1 FROM control_private.session_controls WHERE user_id=$1)
      AND NOT EXISTS(SELECT 1 FROM control_private.attempts WHERE user_id=$1
        AND (evidence_handle IS NOT NULL OR state IN ('ready','consumed')))
      AND NOT EXISTS(SELECT 1 FROM audit.events WHERE subject_id=$1
        AND action IN ('control.evidence','control.login','control.step_up')) AS safe`,
    [principal.userId],
  );
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
}
async function expectPasswordCharge(
  principal: SyntheticPrincipal,
): Promise<void> {
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT (SELECT count(*) FROM control_private.budgets
        WHERE key_mac IN (control_private.mac('budget-account-password',$2::text),
          control_private.mac('budget-ip-password','unknown')) AND used=1)=2
      AND (SELECT count(*) FROM control_private.attempts WHERE user_id=$1 AND purpose='login')=1
      AND (SELECT count(*) FROM audit.events WHERE subject_id=$1 AND action='control.prepared')=1 AS safe`,
    [principal.userId, principal.email],
  );
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
}
async function expectMfaBurnAndCharge(
  principal: SyntheticPrincipal,
): Promise<void> {
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT (SELECT count(*) FROM control_private.budgets
        WHERE key_mac IN (control_private.mac('budget-account-mfa',$1::text),
          control_private.mac('budget-ip-mfa','unknown')) AND used=1)=2
      AND (SELECT count(*) FROM audit.events WHERE subject_id=$1 AND action='control.reserved')=1
      AND EXISTS(SELECT 1 FROM control_private.attempts a
        JOIN control_private.replay_burns b ON b.code_mac=a.code_mac
        WHERE a.user_id=$1 AND a.purpose='login' AND a.state='inflight'
          AND a.operation_handle IS NOT NULL AND a.evidence_handle IS NULL
          AND b.reserved_at=a.reserved_at
          AND b.expires_at=b.reserved_at+interval '180 seconds'
          AND b.expires_at>clock_timestamp()) AS safe`,
    [principal.userId],
  );
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
  await expectPasswordCharge(principal);
}
async function expectNativeFailureCount(
  principal: SyntheticPrincipal,
  count: 0 | 1,
): Promise<void> {
  // Pinned SDK verify-two-factor.mjs164–170 commits its own failed-attempt
  // accounting before returning INVALID_CODE. A later denial-sink outage cannot
  // honestly claim to have rolled this native side effect back.
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT count(*)=1 AND coalesce(bool_and("failedVerificationCount"=$2
      AND "lockedUntil" IS NULL),false) AS safe
      FROM identity."TwoFactor" WHERE "userId"=$1`,
    [principal.userId, count],
  );
  expect(witness.rows.length === 1 && witness.rows[0].safe === true).toBe(true);
}
async function primary(principal: SyntheticPrincipal) {
  const entry = await fx.begin(principal);
  expect(
    entry.operation.response.status === 200 &&
      entry.operation.evidenceHandle === null &&
      entry.jar.header.length > 0,
  ).toBe(true);
  return entry;
}
async function knownInvalidCode(
  principal: SyntheticPrincipal,
): Promise<string> {
  // Same maintained generator as the existing canonical fixtures; any temporary
  // generation-only clock spy is restored BEFORE reserve/SDK/clock sampling.
  const accepted = new Set([
    await fx.code(principal, -1),
    await fx.code(principal),
    await fx.code(principal, 1),
  ]);
  const invalid = ["000000", "000001", "000002", "000003"].find(
    (value) => !accepted.has(value),
  );
  if (!invalid) throw new Error("Synthetic invalid factor unavailable.");
  return invalid;
}

async function withOwnedPersistenceFault(
  target: "factor" | "denial",
  work: () => Promise<void>,
) {
  // The migration client belongs to this NEW ControlFixtures database. Verify its
  // exact binding again before changing any object; never adopt another fixture.
  const suffix = /^bookstore_security_test_([a-f0-9]{12})$/.exec(
    fx.owned.name,
  )?.[1];
  if (!suffix) throw new Error("Owned native denial fixture unavailable.");
  const witness = await fx.migration.query<{ safe: boolean }>(
    `SELECT current_database()=$1 AND current_user::text=$2
      AND pg_get_userbyid(d.datdba)=$2
      AND shobj_description(d.oid,'pg_database') ~ $3 AS safe
      FROM pg_database d WHERE d.datname=current_database()`,
    [
      fx.owned.name,
      `bf_${suffix}_migrate`,
      `^bookstore-security-foundation:${suffix}:[a-f0-9]{32}$`,
    ],
  );
  if (witness.rows.length !== 1 || witness.rows[0].safe !== true)
    throw new Error("Owned native denial marker unavailable.");
  // Fixed offline fault vocabulary only. No runtime grants or definer authority.
  const table = target === "factor" ? 'identity."TwoFactor"' : "audit.denials";
  const event = target === "factor" ? "UPDATE" : "INSERT";
  let created = false,
    triggered = false;
  try {
    await fx.migration.query(
      `CREATE FUNCTION public.b2e_native_denial_fault() RETURNS trigger
        LANGUAGE plpgsql SET search_path=pg_catalog AS $$
        BEGIN RAISE EXCEPTION '${faultText}' USING ERRCODE='P0001'; END $$`,
    );
    created = true;
    await fx.migration.query(
      "REVOKE ALL ON FUNCTION public.b2e_native_denial_fault() FROM PUBLIC",
    );
    await fx.migration.query(
      `CREATE TRIGGER b2e_native_denial_fault BEFORE ${event} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION public.b2e_native_denial_fault()`,
    );
    triggered = true;
    await work();
  } finally {
    // Exact owned objects only; no CASCADE/role reset/connection termination.
    try {
      if (triggered)
        await fx.migration.query(
          `DROP TRIGGER b2e_native_denial_fault ON ${table}`,
        );
    } finally {
      if (created)
        await fx.migration.query(
          "DROP FUNCTION public.b2e_native_denial_fault()",
        );
    }
  }
}

beforeAll(() => secretSafe(() => fx.start()));
beforeEach(() =>
  secretSafe(async () => {
    // Independent cases only. NEVER reset counters inside a denial/fault case.
    await fx.resetScenario();
  }),
);
afterAll(() => secretSafe(() => fx.stop()));

describe("ADR020 F-02 native terminal denial audit completeness", () => {
  scenario(
    "wrong native password records exactly one fixed forbidden denial after successful prepare",
    async () => {
      const principal = await fx.createPrincipal();
      const before = await snapshotDenials();
      const wrongPassword = `${principal.password}invalid`;
      const sentinels = [...privateSentinels(principal), wrongPassword];
      await observeRedactedFailure(
        () => fx.subject.password(principal.email, wrongPassword),
        403,
        sentinels,
      );
      await expectPasswordCharge(principal);
      await expectNoGrant(principal);
      await expectOneOutcome(before, "forbidden", "denied", sentinels);
    },
  );

  scenario(
    "known-invalid native TOTP records one denial without refunding its committed reserve or burn",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await primary(principal);
      const code = await knownInvalidCode(principal);
      await expectNativeFailureCount(principal, 0);
      const before = await snapshotDenials();
      const sentinels = privateSentinels(principal, entry.jar.header);
      await observeRedactedFailure(
        () => fx.subject.verifyTotp(code, entry.jar.header),
        403,
        [...sentinels, code],
      );
      await expectNativeFailureCount(principal, 1);
      await expectMfaBurnAndCharge(principal);
      await expectNoGrant(principal);
      await expectOneOutcome(before, "forbidden", "denied", sentinels);
    },
  );

  scenario(
    "actual post-comparison native persistence fault records unavailable, never provider rolled_back",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await primary(principal);
      const code = await fx.code(principal);
      const before = await snapshotDenials();
      const sentinels = privateSentinels(principal, entry.jar.header);
      await withOwnedPersistenceFault("factor", async () => {
        // Maintained SDK comparison precedes this existing factor-accounting write.
        // This proves an actual native PG failure, not a fabricated SDK response.
        await observeRedactedFailure(
          () => fx.subject.verifyTotp(code, entry.jar.header),
          503,
          [...sentinels, code],
        );
        await expectMfaBurnAndCharge(principal);
        await expectNoGrant(principal);
        await expectOneOutcome(before, "unavailable", "unavailable", sentinels);
      });
    },
  );

  scenario(
    "native password denial plus denial-sink outage returns static unavailable and retains the prepare charge",
    async () => {
      const principal = await fx.createPrincipal();
      const before = await snapshotDenials();
      const wrongPassword = `${principal.password}invalid`;
      await withOwnedPersistenceFault("denial", async () => {
        await observeRedactedFailure(
          () => fx.subject.password(principal.email, wrongPassword),
          503,
          [...privateSentinels(principal), wrongPassword],
        );
        expect((await newDenials(before)).length).toBe(0);
        await expectPasswordCharge(principal);
        await expectNoGrant(principal);
      });
    },
  );

  scenario(
    "native TOTP denial plus denial-sink outage returns static unavailable without unburning the code",
    async () => {
      const principal = await fx.createPrincipal();
      const entry = await primary(principal);
      const code = await knownInvalidCode(principal);
      await expectNativeFailureCount(principal, 0);
      const before = await snapshotDenials();
      await withOwnedPersistenceFault("denial", async () => {
        await observeRedactedFailure(
          () => fx.subject.verifyTotp(code, entry.jar.header),
          503,
          [...privateSentinels(principal, entry.jar.header), code],
        );
        expect((await newDenials(before)).length).toBe(0);
        await expectNativeFailureCount(principal, 1);
        await expectMfaBurnAndCharge(principal);
        await expectNoGrant(principal);
      });
    },
  );
});
