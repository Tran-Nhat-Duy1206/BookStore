import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = fileURLToPath(new URL("../", import.meta.url));
const port = 3102;
const paths = [
  "/__bookstore_test_auth/password",
  "/__bookstore_test_auth/totp/verify",
  "/__bookstore_test_auth/step-up",
  "/__bookstore_test_auth/session",
  "/__bookstore_test_auth/sign-out",
];
async function main() {
  await new Promise<void>((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(new Error("Owned default-off probe port unavailable.")),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolvePort()));
  });
  // An explicit test opt-in ALONE cannot enable anything in a production Next
  // storefront; no auth module/route is imported or mounted by the application.
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    DATA_SOURCE: "fixture",
    BOOKSTORE_RESTRICTED_HTTPS_TEST: "1",
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
    if (process.env[name] !== undefined) env[name] = process.env[name];
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
      stdio: ["ignore", "pipe", "inherit"],
      env,
    },
  );
  let ownListenerReady = false,
    startupFailed = false,
    banner = "";
  child.once("error", () => {
    startupFailed = true;
  });
  child.stdout?.on("data", (bytes: Buffer) => {
    // Wait for THIS owned child's bind-ready signal, not an unrelated listener
    // which might win the free-port race. Never retain/log arbitrary output.
    banner = (banner + bytes.toString("utf8")).slice(-1024);
    if (/Ready in [0-9.]+/.test(banner)) ownListenerReady = true;
  });
  try {
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      if (startupFailed || child.exitCode !== null)
        throw new Error("Owned default-off probe exited early.");
      if (!ownListenerReady) {
        await delay(100);
        continue;
      }
      try {
        const result = await fetch(
          `http://127.0.0.1:${port}/__bookstore_test_probe`,
          { redirect: "manual", signal: AbortSignal.timeout(3000) },
        );
        assert.equal(
          result.status,
          404,
          "Production storefront must not expose the browser test probe.",
        );
        assert.equal(
          result.headers.has("set-cookie"),
          false,
          "Production probe must not emit auth cookies.",
        );
        ready = true;
        break;
      } catch (error) {
        if (error instanceof Error && error.name === "AssertionError")
          throw error;
        await delay(100);
      }
    }
    assert(
      ready,
      "Owned production fixture storefront must answer within the bound.",
    );
    for (const path of paths)
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
          ...(method === "POST"
            ? {
                headers: {
                  origin: `http://127.0.0.1:${port}`,
                  "content-type": "application/json",
                  "x-bookstore-csrf": "1",
                },
                body: "{}",
              }
            : {}),
        });
        assert.equal(
          response.status,
          404,
          "Ordinary production storefront must have no authentication endpoint.",
        );
        assert.equal(
          response.headers.has("set-cookie"),
          false,
          "Absent operational transport must never emit authentication cookies.",
        );
        assert.equal(
          response.headers.has("location"),
          false,
          "Absent operational transport must never redirect into authentication.",
        );
      }
    console.log(
      "PASS: ordinary production fixture storefront exposes no authentication/probe path, cookie or redirect even with explicit test opt-in; owned server stopped.",
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
main().catch(() => {
  console.error(
    "Default-off production transport smoke failed; no unrelated server was used or stopped.",
  );
  process.exitCode = 1;
});
