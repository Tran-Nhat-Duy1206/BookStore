import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config } from "dotenv";
import {
  assertDatabaseUrl,
  getDatabaseUrl,
} from "../src/server/database/config";

const root = fileURLToPath(new URL("../", import.meta.url));
export function runPrisma(args: string[], url: string): Promise<void> {
  assertDatabaseUrl(url);
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [resolve(root, "node_modules/prisma/build/index.js"), ...args],
      {
        cwd: root,
        stdio: "inherit",
        env: { ...process.env, DATABASE_URL: url },
      },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolveRun()
        : reject(new Error("Prisma database command failed.")),
    );
  });
}
async function main() {
  config({ path: ".env.local", quiet: true });
  const action = process.argv[2];
  if (!["migrate", "status"].includes(action ?? ""))
    throw new Error("Use migrate or status.");
  await runPrisma(
    ["migrate", action === "migrate" ? "deploy" : "status"],
    getDatabaseUrl(),
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      "Database command failed. Only the explicit isolated BookStore database is allowed.",
    );
    process.exitCode = 1;
  });
}
