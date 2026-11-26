import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { config } from "dotenv";
import { assertDatabaseUrl } from "../src/server/database/config";

config({ path: ".env.local", quiet: true });
const root = fileURLToPath(new URL("../", import.meta.url));
const port = 3101;
const origin = `http://127.0.0.1:${port}`;
const heading = "Tạm thời chưa thể tải trang";
const guidance =
  "Nhà sách đang gặp sự cố khi tải dữ liệu. Bạn có thể thử tải lại trang.";

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

async function withCatalogServer(
  mode: string,
  url: string,
  probe: (response: Response) => Promise<void>,
) {
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
        response = await fetch(`${origin}/catalog`, {
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
    await probe(response);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolveExit) =>
        child.once("exit", () => resolveExit()),
      );
      child.kill();
      await exited;
    }
  }
}

async function verifyFailure(mode: "database" | "invalid-source", url: string) {
  await withCatalogServer(mode, url, async (response) => {
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
    // Next's production root-error HTML is a bootstrap shell. Assert the
    // recovery copy on the browser-rendered response after Next starts.
    for (const detail of [
      "DATA_SOURCE must be exactly fixture or database.",
      new URL(url).pathname.slice(1),
      "PrismaClientKnownRequestError",
      "PrismaClientInitializationError",
    ]) {
      assert(
        !body.includes(detail),
        "Raw source failure details must not reach the response.",
      );
    }

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({
        viewport: { width: 320, height: 640 },
      });
      try {
        const target = `${origin}/catalog?q=kiem-tra`;
        assert.equal((await page.goto(target))?.status(), 500);
        const title = page.getByRole("heading", {
          name: heading,
          exact: true,
          level: 1,
        });
        await expect(title).toBeVisible();
        await expect(page.getByText(guidance, { exact: true })).toBeVisible();
        const retry = page.getByRole("link", {
          name: "Thử lại",
          exact: true,
        });
        await expect(retry).toBeVisible();
        assert(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <=
              document.documentElement.clientWidth,
          ),
          "Recovery must fit a 320px viewport.",
        );
        await page.keyboard.press("Tab");
        await expect(retry).toBeFocused();
        await expect(retry).toHaveCSS("outline-style", "solid");
        const [retried] = await Promise.all([
          page.waitForResponse(
            (candidate) =>
              candidate.url() === target &&
              candidate.request().isNavigationRequest(),
          ),
          page.keyboard.press("Enter"),
        ]);
        assert.equal(
          retried.status(),
          500,
          "Retry during the ongoing failure must still return HTTP 500.",
        );
        await expect(title).toBeVisible();
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  });
}

async function verifyHealthy(mode: "fixture" | "database", url: string) {
  await withCatalogServer(mode, url, async (response) => {
    assert.equal(response.status, 200, "Healthy catalog must return HTTP 200.");
    assert(
      (await response.text()).includes("Dạo quanh kệ sách"),
      "Healthy catalog must show its normal heading.",
    );
    const missing = await fetch(
      `${origin}/products/unknown-source-smoke-product`,
      { signal: AbortSignal.timeout(10000) },
    );
    assert.equal(
      missing.status,
      404,
      "An unknown product with a healthy source must return HTTP 404.",
    );
    assert(
      !(await missing.text()).includes(heading),
      "Unknown products must not show the global failure interface.",
    );
  });
}

async function main() {
  if (process.argv.length === 3 && process.argv[2] === "--configuration-only") {
    // These modes never initialize the database repository. This URL is an unused redaction sentinel.
    const sentinel =
      "postgresql://unused:source-smoke-sentinel@127.0.0.1:1/unused_source_smoke_database";
    await verifyFailure("invalid-source", sentinel);
    await verifyHealthy("fixture", sentinel);
    await ensureFree();
    console.log(
      "PASS: invalid source HTTP 500 with recovery, and healthy fixture HTTP 200/404.",
    );
    return;
  }
  assert.equal(process.argv.length, 2, "Unexpected smoke-test arguments.");
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
  await verifyHealthy("database", base);
  await ensureFree();
  console.log(
    "PASS: both failures return HTTP 500 with recovery and without fixture fallback or response credential leakage; healthy catalog/product statuses and owned-server cleanup verified.",
  );
}
main().catch((error: unknown) => {
  if (error instanceof assert.AssertionError) console.error(error.message);
  console.error(
    "Data-source HTTP failure smoke check failed. No unrelated server was stopped.",
  );
  process.exitCode = 1;
});
