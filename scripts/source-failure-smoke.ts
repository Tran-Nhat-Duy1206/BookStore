import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "dotenv";
import { assertDatabaseUrl } from "../src/server/database/config";

config({ path: ".env.local", quiet: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const port = 3101;
async function ensureFree() {
  await new Promise<void>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          "Smoke-test port is occupied; no existing process will be used.",
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort()));
  });
}
async function verifyFailure(mode: string, url: string) {
  await ensureFree();
  const child = spawn(
    process.execPath,
    [
      resolve(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        DATA_SOURCE: mode,
        DATABASE_URL: url,
        BOOKSTORE_LOCAL_DB_READS: "1",
      },
    },
  );
  try {
    let response: Response | undefined;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null)
        throw new Error("Owned smoke server exited before the check.");
      try {
        response = await fetch(`http://127.0.0.1:${port}/catalog`, {
          signal: AbortSignal.timeout(10000),
        });
        break;
      } catch {
        await delay(100);
      }
    }
    assert(
      response,
      "Owned smoke server must answer within the bounded startup timeout.",
    );
    assert.equal(
      response.status,
      500,
      "Invalid/missing database source must not serve cached fixture HTML.",
    );
    const body = await response.text();
    assert(
      !body.includes("Khu vườn sau cơn mưa"),
      "Fixture product content must not be substituted.",
    );
    assert(
      !body.includes("12 sách minh họa"),
      "Fixture catalog results must not be substituted.",
    );
    assert(
      !body.includes(decodeURIComponent(new URL(url).password)),
      "Database password must not reach the response.",
    );
  } finally {
    if (child.exitCode === null) {
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );
      child.kill();
      await exited;
    }
  }
}
async function main() {
  const base = process.env.TEST_DATABASE_URL;
  if (!base)
    throw new Error(
      "TEST_DATABASE_URL is required for the isolated source-failure smoke test.",
    );
  assertDatabaseUrl(base);
  if (!/^\/bookstore_catalog_(test|ci)$/.test(new URL(base).pathname))
    throw new Error(
      "Only the isolated test/ci database configuration is allowed.",
    );
  const missing = new URL(base);
  // This name is never created. Only the same owned loopback cluster is contacted.
  missing.pathname = `/bookstore_catalog_test_${randomBytes(6).toString("hex")}`;
  await verifyFailure("database", missing.toString());
  await verifyFailure("invalid-source", missing.toString());
  await ensureFree();
  console.log(
    "PASS: database failure and invalid source each return HTTP 500 without fixture fallback or response credential leakage; owned servers stopped.",
  );
}
main().catch(() => {
  console.error(
    "Data-source HTTP failure smoke check failed. No unrelated server was stopped.",
  );
  process.exitCode = 1;
});
