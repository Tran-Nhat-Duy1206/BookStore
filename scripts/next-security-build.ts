import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
/** Explicit build allowlist: never inherit bootstrap/runtime/provider/TLS secrets. */
export function nextSecurityBuildEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    BOOKSTORE_ISOLATED_NEXT_TEST: "1",
    NEXT_TELEMETRY_DISABLED: "1",
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
function run(args: string[]): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      env: nextSecurityBuildEnvironment(),
      stdio: "inherit",
    });
    child.once("error", () =>
      failed(new Error("Isolated Next build process unavailable.")),
    );
    child.once("exit", (code) =>
      code === 0
        ? done()
        : failed(new Error("Isolated Next build/type gate failed.")),
    );
  });
}
export async function buildNextSecurity(): Promise<void> {
  await run([
    "node_modules/next/dist/bin/next",
    "typegen",
    "experiments/next-security",
  ]);
  await run([
    "node_modules/typescript/bin/tsc",
    "--project",
    "experiments/next-security/tsconfig.json",
    "--noEmit",
  ]);
  await run([
    "node_modules/next/dist/bin/next",
    "build",
    "experiments/next-security",
  ]);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void buildNextSecurity().catch(() => {
    console.error("Isolated Next credential-free build gate failed.");
    process.exitCode = 1;
  });
