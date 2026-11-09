import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// Independent native foundation cluster. Never reuse catalog or auth-spike state.
// node scripts/security-local-db.mjs init|start|stop|status (from physical root).
// init writes the ignored env file; this helper never reads or prints that file.
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const kind = "bookstore-security-postgres18";
const owned = resolve(root, ".local", kind);
const data = resolve(owned, "data");
const marker = resolve(owned, "instance.json");
const secret = resolve(owned, "bootstrap-state.json");
const envFile = resolve(root, ".env.security-foundation.local");
const passwordFile = resolve(owned, "init-password");
const port = 55436;
const owner = "bookstore_security_bootstrap";
const baseDatabase = "bookstore_security_test";
const bin =
  process.env.SECURITY_PG_BIN || "C:\\Program Files\\PostgreSQL\\18\\bin";
const executable = (name) => join(bin, `${name}.exe`);

function assertPhysical(path) {
  // Walk existing ancestors too: junctions and linked parents must fail closed.
  let current = resolve(path);
  for (;;) {
    if (
      existsSync(current) &&
      (lstatSync(current).isSymbolicLink() || realpathSync(current) !== current)
    ) {
      throw new Error("Refusing a linked foundation path or state file.");
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
function assertPaths() {
  if (
    process.platform !== "win32" ||
    !isAbsolute(bin) ||
    resolve(bin) !== bin
  ) {
    throw new Error(
      "This helper uses only installed physical Windows PostgreSQL18 binaries.",
    );
  }
  if (resolve(process.cwd()) !== root || realpathSync(root) !== root) {
    throw new Error("Run from the exact physical BookStore project root.");
  }
  for (const path of [
    root,
    bin,
    owned,
    data,
    marker,
    secret,
    envFile,
    passwordFile,
    resolve(owned, "postgres.log"),
    ...[
      "PG_VERSION",
      "postmaster.pid",
      "postmaster.opts",
      "postgresql.conf",
      "postgresql.auto.conf",
      "pg_hba.conf",
    ].map((name) => resolve(data, name)),
    ...["postgres", "initdb", "pg_ctl"].map(executable),
  ])
    assertPhysical(path);
}
async function run(name, args, capture = false) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable(name), args, {
      cwd: root,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        output += chunk.toString();
      });
    }
    child.once("error", () =>
      reject(new Error(`Could not run installed PostgreSQL18 ${name}.`)),
    );
    child.once("exit", (code) => {
      if (
        code === 0 ||
        (name === "pg_ctl" && args.includes("status") && code === 3)
      )
        resolveRun(output);
      else reject(new Error(`${name} failed; no other cluster will be used.`));
    });
  });
}
async function verifyBinaries() {
  for (const name of ["postgres", "initdb", "pg_ctl"]) {
    if (!existsSync(executable(name)))
      throw new Error("Required installed PostgreSQL18 binaries are missing.");
    if (
      !/\(PostgreSQL\) 18(?:\.|\s|$)/.test(await run(name, ["--version"], true))
    ) {
      throw new Error("Refusing binaries other than PostgreSQL18.");
    }
  }
}
function metadata() {
  if (!existsSync(marker))
    throw new Error(
      "No foundation ownership marker; initialize a fresh isolated cluster first.",
    );
  const state = JSON.parse(readFileSync(marker, "utf8"));
  if (
    state.kind !== kind ||
    state.project !== root ||
    state.directory !== owned ||
    state.data !== data ||
    state.port !== port ||
    state.owner !== owner ||
    state.database !== baseDatabase ||
    state.bin !== bin ||
    !/^[a-f0-9]{32}$/.test(state.id)
  ) {
    throw new Error(
      "Foundation marker does not match the exact root/directory/port/binaries; refusing operation.",
    );
  }
  if (
    !existsSync(data) ||
    readFileSync(resolve(data, "PG_VERSION"), "utf8").trim() !== "18"
  ) {
    throw new Error(
      "Marked data directory is not the expected PostgreSQL18 cluster.",
    );
  }
  const pidFile = resolve(data, "postmaster.pid");
  if (existsSync(pidFile)) {
    const lines = readFileSync(pidFile, "utf8").split(/\r?\n/);
    if (
      !/^[1-9][0-9]*$/.test(lines[0] || "") ||
      resolve(lines[1] || "") !== data ||
      lines[3] !== String(port) ||
      lines[5] !== "127.0.0.1"
    ) {
      throw new Error(
        "Live cluster pid metadata has a different data directory/listener/port; refusing operation.",
      );
    }
  }
  return state;
}
function credentials(state) {
  const saved = JSON.parse(readFileSync(secret, "utf8"));
  if (
    saved.id !== state.id ||
    saved.owner !== owner ||
    !/^[a-f0-9]{64}$/.test(saved.password)
  ) {
    throw new Error(
      "Ignored bootstrap state does not match the owned foundation cluster.",
    );
  }
  return saved;
}
async function assertFreePort() {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          "Foundation port55436 is occupied. Nothing was stopped or reconfigured.",
        ),
      ),
    );
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      server.close((error) =>
        error
          ? reject(
              new Error("Could not finish isolated port availability check."),
            )
          : resolvePort(),
      );
    });
  });
}
async function main() {
  const action = process.argv[2];
  if (
    !action ||
    process.argv.length !== 3 ||
    !["init", "start", "stop", "status"].includes(action)
  ) {
    throw new Error(
      "Use exactly init, start, stop or status; no arbitrary paths, ports or database arguments.",
    );
  }
  assertPaths();
  await verifyBinaries();
  if (action === "init") {
    await assertFreePort();
    if (existsSync(marker)) {
      credentials(metadata());
      console.log(
        "Owned foundation cluster already initialized; use start. No files overwritten.",
      );
      return;
    }
    if (existsSync(owned))
      throw new Error(
        "Foundation directory exists without a matching marker; refusing reuse or overwrite.",
      );
    if (existsSync(envFile))
      throw new Error(
        "Ignored foundation environment file already exists; refusing overwrite.",
      );
    mkdirSync(owned, { recursive: true });
    const password = randomBytes(32).toString("hex");
    const id = randomBytes(16).toString("hex");
    writeFileSync(passwordFile, `${password}\n`, { flag: "wx", mode: 0o600 });
    await run("initdb", [
      "-D",
      data,
      "-U",
      owner,
      "--pwfile",
      passwordFile,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    if (readFileSync(resolve(data, "PG_VERSION"), "utf8").trim() !== "18")
      throw new Error("Initialized cluster is not PostgreSQL18.");
    writeFileSync(secret, JSON.stringify({ id, owner, password }), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      envFile,
      `# Generated ONLY for the isolated BookStore security foundation. Never commit or print.\nSECURITY_TEST_DATABASE_URL=postgresql://${owner}:${password}@127.0.0.1:${port}/${baseDatabase}\n`,
      { flag: "wx", mode: 0o600 },
    );
    // Last write: incomplete initialization is never silently reused.
    writeFileSync(
      marker,
      JSON.stringify(
        {
          kind,
          id,
          project: root,
          directory: owned,
          data,
          port,
          owner,
          database: baseDatabase,
          bin,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Initialized a fresh isolated security-foundation PostgreSQL18 cluster. Credentials remain in ignored local files.",
    );
    return;
  }
  const state = metadata();
  if (action === "start") {
    const saved = credentials(state);
    await assertFreePort();
    await run("pg_ctl", [
      "-D",
      data,
      "-l",
      resolve(owned, "postgres.log"),
      "-o",
      `-p ${port} -h 127.0.0.1`,
      "-w",
      "start",
    ]);
    const client = new Client({
      host: "127.0.0.1",
      port,
      user: owner,
      password: saved.password,
      database: "postgres",
      options:
        "-c log_statement=none -c log_min_error_statement=panic -c log_min_messages=panic",
    });
    let failure = false;
    try {
      await client.connect();
      const identity = await client.query(
        "SELECT current_user AS owner, current_setting('data_directory') AS data, current_setting('port') AS port, current_setting('listen_addresses') AS listener, current_setting('server_version_num') AS version",
      );
      const row = identity.rows[0];
      if (
        row.owner !== owner ||
        resolve(row.data) !== data ||
        row.port !== String(port) ||
        row.listener !== "127.0.0.1" ||
        !/^18[0-9]{4}$/.test(row.version)
      )
        throw new Error("Cluster identity mismatch.");
      const existing = await client.query(
        "SELECT r.rolname AS owner, shobj_description(d.oid, 'pg_database') AS marker FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba WHERE d.datname=$1",
        [baseDatabase],
      );
      const ownership = `bookstore-security-foundation-base:${state.id}`;
      if (!existing.rowCount) {
        await client.query(
          `CREATE DATABASE ${baseDatabase} OWNER ${owner} TEMPLATE template0`,
        );
        await client.query(
          `COMMENT ON DATABASE ${baseDatabase} IS '${ownership}'`,
        );
        await client.query(
          `REVOKE ALL ON DATABASE ${baseDatabase} FROM PUBLIC`,
        );
      } else if (
        existing.rows[0].owner !== owner ||
        existing.rows[0].marker !== ownership
      ) {
        throw new Error(
          "Existing foundation base database is unmarked or has a different owner; refusing reuse.",
        );
      }
    } catch {
      failure = true;
    } finally {
      try {
        await client.end();
      } catch {
        failure = true;
      }
    }
    if (failure)
      throw new Error(
        "Owned foundation startup/bootstrap failed. Cluster may be running; inspect only its ignored state, then use scoped status/stop. No credentials were printed.",
      );
    console.log(
      "Foundation PostgreSQL18 ready on 127.0.0.1:55436. No catalog database or other service was accessed.",
    );
  } else {
    await run("pg_ctl", [
      "-D",
      data,
      ...(action === "stop" ? ["-m", "fast", "-w", "stop"] : ["status"]),
    ]);
  }
}
main().catch((error) => {
  // Do not forward raw pg, filesystem, JSON or spawn diagnostics.
  const allowed =
    error instanceof Error &&
    !/[\r\n]/.test(error.message) &&
    /^(Use exactly |This helper |Run from |Refusing |Could not |Required installed |No foundation |Foundation |Marked data |Live cluster |Ignored |Owned |Initialized cluster |postgres failed|initdb failed|pg_ctl failed)/.test(
      error.message,
    );
  console.error(
    allowed
      ? error.message
      : "Foundation operation failed. Check only the owned directory and installed PostgreSQL18 binaries; no other service was accessed.",
  );
  process.exitCode = 1;
});
