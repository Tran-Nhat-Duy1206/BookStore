import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertFoundationUrl } from "../src/server/security/database-config";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Offline only: same canonical migration history, different exact-purpose credentials. */
export function runSecurityMigrations(
  url: string,
  action: "deploy" | "status" = "deploy",
): Promise<void> {
  assertFoundationUrl(url, "migrate");
  if (!["deploy", "status"].includes(action))
    throw new Error("Unsupported migration operation.");
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve(root, "node_modules/prisma/build/index.js"),
        "migrate",
        action,
        "--config",
        "prisma.security.config.ts",
      ],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, SECURITY_MIGRATION_DATABASE_URL: url },
      },
    );
    child.once("error", () =>
      reject(new Error("Security migration process unavailable.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error("Canonical security migration failed.")),
    );
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const action = process.argv[2];
  if (action !== "deploy" && action !== "status") {
    console.error(
      "Use deploy or status in a separately configured offline migration process.",
    );
    process.exitCode = 1;
  } else {
    void runSecurityMigrations(
      process.env.SECURITY_MIGRATION_DATABASE_URL ?? "",
      action,
    ).catch(() => {
      console.error(
        "Security migration failed. Check only the explicit owned migration profile; credentials/errors are not printed.",
      );
      process.exitCode = 1;
    });
  }
}
