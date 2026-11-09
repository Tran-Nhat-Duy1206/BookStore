import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSecurityMigrations } from "../../scripts/security-database";
import {
  assertFoundationBaseUrl,
  assertFoundationUrl,
  type FoundationPurpose,
} from "../../src/server/security/database-config";
import { createFoundationDatabase, type FoundationDatabase } from "./database";

const purposes: FoundationPurpose[] = [
  "migrate",
  "reader",
  "auth",
  "staff",
  "worker",
];
const runtime = ["reader", "auth", "staff", "worker"] as const;
const catalog = [
  "Work",
  "Series",
  "SeriesWork",
  "Volume",
  "Publisher",
  "Edition",
  "EditionContent",
  "Product",
  "Sku",
  "Category",
  "WorkCategory",
  "Contributor",
  "WorkContributor",
  "EditionContributor",
];
const provider = [
  "User",
  "Session",
  "Account",
  "Verification",
  "TwoFactor",
  "RateLimit",
];
const safeStaff = [
  "roles",
  "permissions",
  "role_permissions",
  "principals",
  "role_grants",
  "admissions",
  "governance",
];
let db: FoundationDatabase;
const clients = {} as Record<FoundationPurpose, Client>;
const opened: Client[] = [];
const roles = {} as Record<FoundationPurpose, string>;
let guard: string;

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  opened.push(client);
  await client.connect();
  return client;
}
async function denied(client: Client, sql: string): Promise<void> {
  // Check the actual ACL SQLSTATE, not an unrelated syntax/constraint failure.
  await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
}
function ownedIdentifier(name: string): string {
  if (!/^bookstore_security_test_[a-f0-9]{12}$/.test(name))
    throw new Error("Unexpected disposable database identifier.");
  return `"${name}"`;
}
beforeAll(async () => {
  db = await createFoundationDatabase();
  await runSecurityMigrations(db.migrationUrl);
  await db.hardenPrivileges();
  const urls = {
    migrate: db.migrationUrl,
    reader: db.readerUrl,
    auth: db.authUrl,
    staff: db.staffUrl,
    worker: db.workerUrl,
  };
  for (const purpose of purposes) {
    roles[purpose] = new URL(urls[purpose]).username;
    clients[purpose] = await connect(urls[purpose]);
  }
  guard = roles.migrate.replace(/_migrate$/, "_guard");
}, 120_000);
afterAll(async () => {
  const closed = await Promise.allSettled(opened.map((client) => client.end()));
  await db?.dispose();
  for (const result of closed)
    if (result.status === "rejected") throw result.reason;
}, 30_000);

describe("foundation role attributes and definer ownership", () => {
  it.each(purposes)(
    "%s has no cluster privilege or membership",
    async (purpose) => {
      const result = await clients.migrate.query(
        "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1",
        [roles[purpose]],
      );
      expect(result.rows).toEqual([
        {
          rolcanlogin: true,
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolbypassrls: false,
          rolinherit: false,
        },
      ]);
      const memberships = await clients.migrate.query(
        "SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname=$1",
        [roles[purpose]],
      );
      expect(memberships.rows[0].n).toBe(0);
    },
  );
  it("guard is a restricted NOLOGIN role without memberships", async () => {
    const result = await clients.migrate.query(
      "SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=$1",
      [guard],
    );
    expect(result.rows).toEqual([
      {
        rolcanlogin: false,
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolbypassrls: false,
        rolinherit: false,
      },
    ]);
    expect(
      (
        await clients.migrate.query(
          "SELECT count(*)::int AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member OR r.oid=m.roleid WHERE r.rolname=$1",
          [guard],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("migration alone owns the database and all underlying tables", async () => {
    expect(
      (
        await clients.migrate.query(
          "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0].owner,
    ).toBe(roles.migrate);
    const result = await clients.migrate.query(
      "SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname IN ('public','identity','staff','audit')",
    );
    expect(result.rows).toEqual([{ tableowner: roles.migrate }]);
  });
  it("all canonical functions use guard ownership, definer and fixed pg_catalog search path", async () => {
    const result = await clients.migrate.query(
      "SELECT pg_get_userbyid(p.proowner) AS owner,p.prosecdef,p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('staff','audit')",
    );
    expect(result.rows.length).toBeGreaterThan(8);
    for (const row of result.rows) {
      expect(row.owner).toBe(guard);
      expect(row.prosecdef).toBe(true);
      expect(row.proconfig).toContain("search_path=pg_catalog");
    }
    expect(
      (
        await clients.migrate.query(
          "SELECT has_schema_privilege($1,'staff','CREATE') OR has_schema_privilege($1,'audit','CREATE') AS allowed",
          [guard],
        )
      ).rows[0].allowed,
    ).toBe(false);
  });
  it("PUBLIC has no EXECUTE grant on any canonical function", async () => {
    const result = await clients.migrate.query(
      "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE n.nspname IN ('staff','audit') AND a.grantee=0 AND a.privilege_type='EXECUTE'",
    );
    expect(result.rows[0].n).toBe(0);
  });
});

describe("reader has only catalog SELECT", () => {
  it.each(catalog)("can SELECT public.%s", async (table) => {
    expect(
      (
        await clients.reader.query(
          `SELECT count(*)::int AS n FROM public."${table}"`,
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("cannot access migration history", async () =>
    denied(clients.reader, 'SELECT * FROM public."_prisma_migrations"'));
  it("cannot write after disabling transaction read-only", async () => {
    await clients.reader.query("SET default_transaction_read_only=off");
    await denied(
      clients.reader,
      'UPDATE public."Product" SET "merchandisingTitle"=\'forged\' WHERE false',
    );
    await denied(clients.reader, 'DELETE FROM public."Product" WHERE false');
    await denied(clients.reader, 'TRUNCATE public."Product"');
  });
  it.each(['identity."User"', "staff.roles", "audit.events"])(
    "cannot read %s",
    async (table) => denied(clients.reader, `SELECT * FROM ${table}`),
  );
});

describe("auth is only six-table provider persistence", () => {
  it.each(provider)("can SELECT identity.%s", async (table) => {
    await expect(
      clients.auth.query(`SELECT * FROM identity."${table}" LIMIT 0`),
    ).resolves.toMatchObject({ rowCount: 0 });
  });
  it("can perform real provider DML while definer triggers enqueue bounded transitions", async () => {
    const id = randomUUID();
    await clients.auth.query(
      'INSERT INTO identity."User" (id,name,email,"updatedAt") VALUES ($1,$2,$3,now())',
      [id, "Synthetic ACL fixture", `${id}@example.invalid`],
    );
    await clients.auth.query(
      'INSERT INTO identity."Account" (id,"accountId","providerId","userId",password,"updatedAt") VALUES ($1,$1,\'credential\',$1,\'synthetic-not-a-password-hash\',now())',
      [id],
    );
    await clients.auth.query(
      'INSERT INTO identity."TwoFactor" (id,"userId",secret,"backupCodes") VALUES ($1,$1,\'synthetic-factor\',\'synthetic-backup\')',
      [id],
    );
    await clients.auth.query(
      'INSERT INTO identity."Session" (id,token,"userId","expiresAt","updatedAt") VALUES ($1,$2,$1,now()+interval \'1 hour\',now())',
      [id, `synthetic-${id}`],
    );
    await clients.auth.query(
      'INSERT INTO identity."Verification" (id,identifier,value,"expiresAt","updatedAt") VALUES ($1,$1,\'synthetic-only\',now(),now())',
      [id],
    );
    await clients.auth.query(
      'INSERT INTO identity."RateLimit" (id,key,count,"lastRequest") VALUES ($1,$1,1,0)',
      [id],
    );
    for (const table of provider) {
      expect(
        (
          await clients.auth.query(
            `SELECT id FROM identity."${table}" WHERE id=$1`,
            [id],
          )
        ).rows,
      ).toEqual([{ id }]);
    }
    await clients.auth.query(
      'UPDATE identity."User" SET name=\'Synthetic updated\',"updatedAt"=now() WHERE id=$1',
      [id],
    );
    expect(
      (
        await clients.migrate.query(
          "SELECT count(*)::int AS n FROM audit.provider_events WHERE user_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBeGreaterThanOrEqual(4);
    expect(
      (
        await clients.migrate.query(
          "SELECT count(*)::int AS n FROM staff.principals WHERE user_id=$1",
          [id],
        )
      ).rows[0].n,
    ).toBe(0);
    await clients.auth.query('DELETE FROM identity."User" WHERE id=$1', [id]);
    await clients.auth.query(
      'DELETE FROM identity."Verification" WHERE id=$1',
      [id],
    );
    await clients.auth.query('DELETE FROM identity."RateLimit" WHERE id=$1', [
      id,
    ]);
  });
  it.each([
    "staff.role_grants",
    "staff.principals",
    "audit.events",
    "audit.provider_events",
    'public."Product"',
  ])("cannot read %s", async (table) =>
    denied(clients.auth, `SELECT * FROM ${table}`),
  );
  it("cannot truncate provider persistence", async () =>
    denied(clients.auth, 'TRUNCATE identity."RateLimit"'));
  it("cannot directly append ledger or grant roles", async () => {
    await denied(
      clients.auth,
      "INSERT INTO audit.events(action,source) VALUES ('principal.insert','auth')",
    );
    await denied(
      clients.auth,
      "INSERT INTO staff.roles(name) VALUES ('ForgedOwner')",
    );
  });
});

describe("staff safe reads and reviewed functions only", () => {
  it.each(safeStaff)("can SELECT staff.%s", async (table) => {
    await expect(
      clients.staff.query(`SELECT * FROM staff.${table}`),
    ).resolves.toBeDefined();
  });
  it("can SELECT audit.events", async () => {
    await clients.staff.query("SELECT * FROM audit.events");
  });
  it.each([
    "roles",
    "role_permissions",
    "role_grants",
    "principals",
    "admissions",
    "governance",
  ])("cannot raw mutate staff.%s", async (table) => {
    await denied(clients.staff, `DELETE FROM staff.${table} WHERE false`);
  });
  it("cannot directly update governance or insert a principal", async () => {
    await denied(
      clients.staff,
      "UPDATE staff.governance SET state='bootstrap'",
    );
    await denied(
      clients.staff,
      "INSERT INTO staff.principals(user_id,status) VALUES ('forged','active')",
    );
  });
  it.each([
    "UPDATE audit.events SET actor_id='forged' WHERE false",
    "DELETE FROM audit.events WHERE false",
    "TRUNCATE audit.events",
    "INSERT INTO audit.events(action,source) VALUES ('principal.insert','staff')",
  ])("cannot alter audit evidence: %s", async (sql) =>
    denied(clients.staff, sql),
  );
  it.each([
    'identity."Account"',
    'identity."TwoFactor"',
    "audit.provider_events",
    "audit.denials",
  ])("cannot read secrets/private sink %s", async (table) =>
    denied(clients.staff, `SELECT * FROM ${table}`),
  );
  it.each([
    "SELECT staff.check_access('forged','forged','security.staff.roles',0) AS decision",
    "SELECT staff.set_status('forged','forged',0,'forged','active') AS decision",
    "SELECT staff.replace_roles('forged','forged',0,'forged',ARRAY['Owner']) AS decision",
    "SELECT staff.revoke_admission('forged','forged',0,'forged') AS decision",
  ])(
    "reviewed function denies forged actor without escalation: %s",
    async (sql) => {
      expect((await clients.staff.query(sql)).rows[0].decision.allowed).toBe(
        false,
      );
      expect(
        (
          await clients.staff.query(
            "SELECT count(*)::int AS n FROM staff.principals",
          )
        ).rows[0].n,
      ).toBe(0);
    },
  );
  it("may record a bounded denial through the sole reviewed sink", async () => {
    const id = randomUUID();
    await clients.staff.query(
      "SELECT audit.record_denial($1,'forbidden','denied')",
      [id],
    );
    expect(
      (
        await clients.migrate.query(
          "SELECT reason,outcome FROM audit.denials WHERE id=$1",
          [id],
        )
      ).rows,
    ).toEqual([{ reason: "forbidden", outcome: "denied" }]);
  });
  it("cannot call internal Owner-count helper or worker function", async () => {
    await denied(clients.staff, "SELECT staff.eligible_owner_count()");
    await denied(
      clients.staff,
      "SELECT * FROM audit.pending_provider_events(1)",
    );
  });
});

describe("worker executes reconciliation without raw data authority", () => {
  it("can execute precisely the three worker entry points", async () => {
    await clients.worker.query(
      "SELECT * FROM audit.pending_provider_events(1)",
    );
    expect(
      (
        await clients.worker.query(
          "SELECT audit.reconcile_provider_event(-1) AS done",
        )
      ).rows[0].done,
    ).toBe(false);
    await clients.worker.query(
      "SELECT audit.record_reconcile_failure(-1,'apply_failed')",
    );
  });
  it.each([
    'identity."User"',
    'identity."Account"',
    'identity."TwoFactor"',
    "staff.roles",
    "staff.role_permissions",
    "audit.events",
    "audit.provider_events",
    "audit.denials",
  ])("cannot raw SELECT %s", async (table) =>
    denied(clients.worker, `SELECT * FROM ${table}`),
  );
  it.each([
    "UPDATE audit.provider_events SET state='blocked' WHERE false",
    "DELETE FROM audit.events WHERE false",
    "INSERT INTO staff.roles(name) VALUES ('ForgedOwner')",
    "TRUNCATE audit.denials",
  ])("cannot raw DML: %s", async (sql) => denied(clients.worker, sql));
  it("cannot call staff access or denial entry points", async () => {
    await denied(
      clients.worker,
      "SELECT staff.check_access('forged','forged','security.self.read',0)",
    );
    await denied(
      clients.worker,
      "SELECT audit.record_denial('00000000-0000-0000-0000-000000000001','forbidden','denied')",
    );
  });
});

describe("all runtime roles are isolated from DDL, admission and escalation", () => {
  it.each(runtime)(
    "%s cannot create objects, TEMP, roles or databases",
    async (purpose) => {
      const client = clients[purpose];
      await denied(client, "CREATE SCHEMA forged_schema");
      await denied(client, "CREATE TABLE public.forged_table(id integer)");
      await denied(client, "CREATE TEMP TABLE forged_temp(id integer)");
      await denied(client, "CREATE ROLE forged_role");
      await denied(client, "CREATE DATABASE forged_database");
      await denied(client, `ALTER ROLE "${roles[purpose]}" SUPERUSER`);
    },
  );
  it.each(runtime)("%s cannot SET ROLE migrate or guard", async (purpose) => {
    await denied(clients[purpose], `SET ROLE "${roles.migrate}"`);
    await denied(clients[purpose], `SET ROLE "${guard}"`);
  });
  it.each(runtime)("%s cannot forge verified admission", async (purpose) => {
    await denied(
      clients[purpose],
      "INSERT INTO staff.admissions(session_id,user_id,authz_version,mode,mfa_at) VALUES ('forged','forged',0,'verified',now())",
    );
  });
  it.each(["reader", "auth"] as const)(
    "%s cannot execute any canonical function",
    async (purpose) => {
      const result = await clients.migrate.query(
        "SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('staff','audit') AND has_function_privilege($1,p.oid,'EXECUTE')",
        [roles[purpose]],
      );
      expect(result.rows[0].n).toBe(0);
    },
  );
});

describe("strict independent foundation URL guards", () => {
  const suffix = "123456abcdef";
  const url = (purpose: FoundationPurpose, port = "55436") =>
    `postgresql://bf_${suffix}_${purpose}:synthetic-local-only@127.0.0.1:${port}/bookstore_security_test_${suffix}`;
  it.each(purposes)(
    "returns original matching %s URL on local and CI ports",
    (purpose) => {
      for (const port of ["55436", "55437"])
        expect(assertFoundationUrl(url(purpose, port), purpose)).toBe(
          url(purpose, port),
        );
    },
  );
  it.each([
    "",
    url("reader").replace(":55436", ":5432"),
    url("reader").replace(":55436", ":55432"),
    url("reader").replace(":55436", ":55434"),
    url("reader").replace("127.0.0.1", "example.invalid"),
    url("reader") + "?",
    url("reader") + "#",
    url("reader") + "?sslmode=disable",
    url("reader").replace("123456abcdef_reader", "abcdef123456_reader"),
    url("auth"),
    url("reader").replace("_reader:", "_guard:"),
    url("reader").replace(
      "/bookstore_security_test_",
      "/bookstore_auth_spike_test_",
    ),
    url("reader").replace("synthetic-local-only", ""),
    url("reader").replace("synthetic-local-only", "%0A"),
    url("reader").replace(
      "/bookstore_security_test_",
      "/x/../bookstore_security_test_",
    ),
    url("reader").replace("127.0.0.1", "127.0.0.1.evil.invalid"),
  ])("rejects unsafe reader URL matrix case %#", (value) => {
    expect(() => assertFoundationUrl(value, "reader")).toThrow();
  });
  it("allows only the exact local and CI bootstrap pair", () => {
    for (const [port, name] of [
      ["55436", "bookstore_security_test"],
      ["55437", "bookstore_security_ci"],
    ]) {
      const base = `postgresql://bookstore_security_bootstrap:synthetic-local-only@127.0.0.1:${port}/${name}`;
      expect(assertFoundationBaseUrl(base)).toBe(base);
      expect(() =>
        assertFoundationBaseUrl(
          base.replace(
            name,
            name === "bookstore_security_ci"
              ? "bookstore_security_test"
              : "bookstore_security_ci",
          ),
        ),
      ).toThrow();
    }
    expect(() => assertFoundationBaseUrl(url("migrate"))).toThrow();
    // Empty input must fail, not consult DATABASE_URL/TEST_DATABASE_URL/spike vars.
    expect(() => assertFoundationBaseUrl("")).toThrow();
  });
});

describe("guarded disposable cleanup never forces or trusts a mismatched marker", () => {
  it("refuses active clients, leaves them alive, then succeeds after close", async () => {
    const disposable = await createFoundationDatabase();
    let client: Client | undefined;
    try {
      ownedIdentifier(disposable.name);
      client = new Client({ connectionString: disposable.migrationUrl });
      await client.connect();
      await expect(disposable.dispose()).rejects.toThrow();
      expect(
        (await client.query("SELECT current_database() AS name")).rows[0].name,
      ).toBe(disposable.name);
    } finally {
      try {
        await client?.end();
      } finally {
        await disposable.dispose();
      }
    }
  }, 30_000);
  it("refuses a changed database COMMENT without dropping it; restoration allows cleanup", async () => {
    const disposable = await createFoundationDatabase();
    let client: Client | undefined;
    let marker: string | undefined;
    const name = ownedIdentifier(disposable.name);
    try {
      client = new Client({ connectionString: disposable.migrationUrl });
      await client.connect();
      marker = (
        await client.query(
          "SELECT shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=current_database()",
        )
      ).rows[0].marker;
      if (
        !marker ||
        !/^bookstore-security-foundation:[a-f0-9]{12}:[a-f0-9]{32}$/.test(
          marker,
        )
      )
        throw new Error("Unexpected run marker.");
      await client.query(
        `COMMENT ON DATABASE ${name} IS 'deliberate-test-marker-mismatch'`,
      );
      // No active-client obstacle: only the mismatched ownership marker can
      // protect this database. Reconnect afterwards to prove it survived.
      await client.end();
      client = undefined;
      await expect(disposable.dispose()).rejects.toThrow();
      client = new Client({ connectionString: disposable.migrationUrl });
      await client.connect();
      expect(
        (await client.query("SELECT current_database() AS name")).rows[0].name,
      ).toBe(disposable.name);
    } finally {
      try {
        if (
          client &&
          marker &&
          /^bookstore-security-foundation:[a-f0-9]{12}:[a-f0-9]{32}$/.test(
            marker,
          )
        ) {
          await client.query(`COMMENT ON DATABASE ${name} IS '${marker}'`);
        }
      } finally {
        try {
          await client?.end();
        } finally {
          await disposable.dispose();
        }
      }
    }
  }, 30_000);
});
