import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url)),
  port = 3106;
const paths = [
  "/__bookstore_next_security",
  "/__bookstore_next_auth/password",
  "/__bookstore_next_auth/totp/verify",
  "/__bookstore_next_auth/step-up",
  "/__bookstore_next_auth/session",
  "/__bookstore_next_auth/sign-out",
  "/api/auth/sign-in/email",
  "/api/auth/sign-up/email",
];
async function rootArtifactBoundary() {
  const routes: unknown = JSON.parse(
    await readFile(
      resolve(root, ".next/server/app-paths-manifest.json"),
      "utf8",
    ),
  );
  assert(routes && typeof routes === "object");
  assert(
    !Object.keys(routes).some((route) =>
      /bookstore_next|bookstore_test_auth|\/api\/auth/.test(route),
    ),
    "Ordinary production route manifest must exclude isolated security.",
  );
  let traces = 0;
  async function walk(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert(
        !entry.isSymbolicLink(),
        "Ordinary build must not use symbolic-link trace files.",
      );
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".nft.json")) {
        traces++;
        const value: unknown = JSON.parse(await readFile(path, "utf8"));
        assert(
          value &&
            typeof value === "object" &&
            "files" in value &&
            Array.isArray(value.files),
        );
        assert(
          value.files.every(
            (file: unknown) =>
              typeof file === "string" &&
              !/experiments[\\/]next-security|better-auth[\\/]|server[\\/]security[\\/](provider-proof|reconciliation-worker)/i.test(
                file,
              ),
          ),
          "Ordinary output traces must exclude canonical/experimental auth runtime.",
        );
      }
    }
  }
  await walk(resolve(root, ".next/server"));
  assert(traces > 0, "Ordinary build trace evidence must exist.");
}
function environment(
  mode: "development" | "production",
  enabled: boolean,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: mode,
    DATA_SOURCE: "fixture",
    BOOKSTORE_ORDINARY_MODE: mode,
    NEXT_TELEMETRY_DISABLED: "1",
    ...(enabled
      ? {
          BOOKSTORE_ISOLATED_NEXT_TEST: "1",
          BOOKSTORE_RESTRICTED_HTTPS_TEST: "1",
          BOOKSTORE_NEXT_SECURITY_CONFIG: '{"enabled":true}',
        }
      : {}),
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
  return env;
}
async function probe(mode: "development" | "production", enabled: boolean) {
  await new Promise<void>((done, failed) => {
    const socket = createServer();
    socket.once("error", () =>
      failed(new Error("Owned negative fixture port unavailable.")),
    );
    socket.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      socket.close(() => done()),
    );
  });
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/next-security-ordinary-host.ts"],
    {
      cwd: root,
      env: environment(mode, enabled),
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    },
  );
  let ended = false;
  const exit = new Promise<void>((done) =>
    child.once("exit", () => {
      ended = true;
      done();
    }),
  );
  try {
    await new Promise<void>((ready, failed) => {
      let banner = "";
      const timeout = setTimeout(
        () =>
          failed(new Error("Owned ordinary fixture startup bound exceeded.")),
        45000,
      );
      const fail = () => {
        clearTimeout(timeout);
        failed(new Error("Owned ordinary fixture failed before ready."));
      };
      child.once("error", fail);
      child.once("exit", fail);
      child.stdout?.on("data", (chunk) => {
        banner = (banner + chunk.toString("utf8")).slice(-2048);
        if (banner.includes("BookStore ordinary negative fixture ready.")) {
          clearTimeout(timeout);
          child.removeListener("exit", fail);
          child.removeListener("error", fail);
          ready();
        }
      });
    });
    for (const path of paths)
      for (const method of ["GET", "POST"]) {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          redirect: "manual",
          signal: AbortSignal.timeout(10000),
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
          "Ordinary root development/production must not expose security/auth endpoints.",
        );
        assert.equal(
          response.headers.has("set-cookie"),
          false,
          "Ordinary absent security must emit no credential.",
        );
        assert.equal(
          response.headers.has("location"),
          false,
          "Ordinary absent security must not redirect into authentication.",
        );
        await response.arrayBuffer();
      }
  } finally {
    if (!ended) {
      if (child.connected && mode === "production" && enabled)
        child.disconnect();
      else if (child.connected) child.send({ operation: "close" });
      else child.kill("SIGTERM");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          exit,
          new Promise<never>((_, failed) => {
            timer = setTimeout(
              () =>
                failed(
                  new Error("Owned ordinary fixture cleanup exceeded bound."),
                ),
              15000,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (!ended) {
          child.kill("SIGKILL");
          await exit;
        }
      }
    }
  }
}
void (async () => {
  await rootArtifactBoundary();
  for (const mode of ["development", "production"] as const)
    for (const enabled of [false, true]) await probe(mode, enabled);
  console.log(
    "PASS: ordinary root dev/production, with AND without isolated opt-ins, exclude security routes/cookies/redirects; ordinary production route+trace boundary verified.",
  );
})().catch(() => {
  console.error(
    "Next default-off isolation gate failed; no unrelated listener was used/stopped.",
  );
  process.exitCode = 1;
});
