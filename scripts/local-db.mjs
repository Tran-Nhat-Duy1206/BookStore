import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const owned = resolve(root, ".local", "bookstore-postgres18");
const data = resolve(owned, "data");
const marker = resolve(owned, "instance.json");
const envFile = resolve(root, ".env.local");
const port = 55432;
const bin =
  process.env.PG_BIN ||
  (process.platform === "win32"
    ? "C:\\Program Files\\PostgreSQL\\18\\bin"
    : "");
const executable = (name) =>
  bin ? join(bin, name + (process.platform === "win32" ? ".exe" : "")) : name;
const run = (name, args) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(executable(name), args, {
      stdio: "inherit",
      cwd: root,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(
            new Error(
              `${name} exited ${code}. No other instance will be used.`,
            ),
          ),
    );
  });
function metadata() {
  if (!existsSync(marker))
    throw new Error(
      "No BookStore-owned instance marker. Run db:local:init first.",
    );
  const state = JSON.parse(readFileSync(marker, "utf8"));
  if (
    state.project !== root ||
    state.data !== data ||
    state.port !== port ||
    state.owner !== "bookstore_catalog"
  ) {
    throw new Error(
      "Instance marker does not match the exact BookStore directory/port. Refusing operation.",
    );
  }
  return state;
}
async function assertFreePort() {
  await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Port ${port} is occupied. Nothing was stopped or reconfigured.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(resolvePort));
  });
}
async function main() {
  const action = process.argv[2];
  if (!["init", "start", "stop", "status"].includes(action))
    throw new Error("Use init, start, stop or status.");
  if (action === "init") {
    await assertFreePort();
    if (existsSync(marker)) {
      metadata();
      console.log("Owned cluster already initialized; use db:local:start.");
      return;
    }
    if (existsSync(data))
      throw new Error(
        "Data directory already exists without an ownership marker. Refusing reuse.",
      );
    if (existsSync(envFile))
      throw new Error(
        ".env.local already exists. Refusing to overwrite it. Use the documented manual isolated setup.",
      );
    mkdirSync(owned, { recursive: true });
    const password = randomBytes(32).toString("hex");
    const passwordFile = resolve(owned, "local-password");
    writeFileSync(passwordFile, password + "\n", { flag: "wx", mode: 0o600 });
    await run("initdb", [
      "-D",
      data,
      "-U",
      "bookstore_catalog",
      "--pwfile",
      passwordFile,
      "--auth=scram-sha-256",
      "--encoding=UTF8",
      "--locale=C",
    ]);
    const state = {
      project: root,
      data,
      port,
      owner: "bookstore_catalog",
      password,
    };
    writeFileSync(marker, JSON.stringify(state, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
    writeFileSync(
      envFile,
      `# Generated for this isolated BookStore development instance; never commit.\nDATA_SOURCE=fixture\nDATABASE_URL=postgresql://bookstore_catalog:${password}@127.0.0.1:${port}/bookstore_catalog_dev\nTEST_DATABASE_URL=postgresql://bookstore_catalog:${password}@127.0.0.1:${port}/bookstore_catalog_test\nBOOKSTORE_POSTGRES_PASSWORD=${password}\n`,
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      `Initialized a new BookStore-only cluster at ${data}. Credentials stay in ignored local files.`,
    );
    return;
  }
  const state = metadata();
  if (action === "start") {
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
      user: state.owner,
      password: state.password,
      database: "postgres",
    });
    try {
      await client.connect();
      for (const name of ["bookstore_catalog_dev", "bookstore_catalog_test"]) {
        const existing = await client.query(
          "SELECT 1 FROM pg_database WHERE datname=$1",
          [name],
        );
        if (!existing.rowCount) await client.query(`CREATE DATABASE ${name}`);
      }
    } finally {
      await client.end();
    }
    console.log(
      `BookStore-only PostgreSQL ready on 127.0.0.1:${port}. No service/port 5432 was accessed.`,
    );
  } else {
    await run("pg_ctl", [
      "-D",
      data,
      ...(action === "stop" ? ["-m", "fast", "-w", "stop"] : ["status"]),
    ]);
  }
}
main().catch(() => {
  // Do not print environment values, connection strings or credentials.
  console.error(
    "BookStore local database operation failed. Check the owned directory/port, PG_BIN and the messages above. No existing service was stopped or reused.",
  );
  process.exitCode = 1;
});
