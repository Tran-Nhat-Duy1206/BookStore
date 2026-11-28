import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateReleaseConfig,
  releaseHost,
  type ReleaseEnvironment,
} from "../src/server/release-config";

const entry = fileURLToPath(import.meta.url);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));

type LaunchOptions = {
  root?: string;
  spawnChild?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  report?: (message: string) => void;
};

async function checkBuild(root: string, cli: string) {
  async function requiredFile(path: string) {
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size === 0) throw new Error();
  }
  async function manifest(path: string): Promise<Record<string, unknown>> {
    await requiredFile(path);
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  }
  const build = resolve(root, ".next");
  await requiredFile(cli);
  const buildId = resolve(build, "BUILD_ID");
  await requiredFile(buildId);
  if (!/^[A-Za-z0-9_-]+$/.test((await readFile(buildId, "utf8")).trim()))
    throw new Error();
  const routes = await manifest(resolve(build, "routes-manifest.json"));
  const prerender = await manifest(resolve(build, "prerender-manifest.json"));
  const required = await manifest(resolve(build, "required-server-files.json"));
  const config = required.config as { distDir?: unknown } | undefined;
  if (
    routes.version !== 3 ||
    !Array.isArray(routes.staticRoutes) ||
    !Array.isArray(routes.dynamicRoutes) ||
    prerender.version !== 4 ||
    !prerender.routes ||
    !prerender.dynamicRoutes ||
    required.version !== 1 ||
    config?.distDir !== ".next" ||
    !Array.isArray(required.files) ||
    !required.files.length
  )
    throw new Error();
  const paths = await manifest(
    resolve(build, "server/app-paths-manifest.json"),
  );
  if (paths["/catalog/page"] !== "app/catalog/page.js") throw new Error();
  await requiredFile(resolve(build, "server/app/catalog/page.js"));
}

function portIsAvailable(port: number): Promise<boolean> {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.listen({ host: releaseHost, port, exclusive: true }, () => {
      probe.close((error) => done(!error));
    });
  });
}

function waitForOwnedChild(
  child: ChildProcess,
  report: (message: string) => void,
): Promise<number> {
  return new Promise((done) => {
    let stopping: "SIGINT" | "SIGTERM" | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const requestStop = (signal: "SIGINT" | "SIGTERM") => {
      if (stopping || child.exitCode !== null || child.signalCode !== null)
        return;
      stopping = signal;
      child.kill(signal);
      escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, 5000);
      escalation.unref();
    };
    const onInterrupt = () => requestStop("SIGINT");
    const onTerminate = () => requestStop("SIGTERM");
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    let failed = false;
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (code, signal) => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
      clearTimeout(escalation);
      if (stopping === "SIGINT") return done(130);
      if (stopping === "SIGTERM") return done(143);
      if (!failed && code === 0) return done(0);
      report(
        "The staging demonstration server stopped with an error. Check the build and port, then try again.",
      );
      done(
        code && code > 0
          ? code
          : signal === "SIGINT"
            ? 130
            : signal === "SIGTERM"
              ? 143
              : 1,
      );
    });
  });
}

export async function runRelease(
  args: readonly string[],
  inherited: ReleaseEnvironment,
  options: LaunchOptions = {},
): Promise<number> {
  const report =
    options.report ?? ((message: string) => console.error(message));
  const selection = evaluateReleaseConfig(args, inherited);
  if (!selection.ok) {
    report(selection.message);
    return 1;
  }
  const root = options.root ?? projectRoot;
  const cli = resolve(root, "node_modules/next/dist/bin/next");
  try {
    await checkBuild(root, cli);
  } catch {
    report(
      "A usable production build and installed Next.js are required. Run the existing fixture build first.",
    );
    return 1;
  }
  const { port, env } = selection.config;
  if (!(await portIsAvailable(port))) {
    report(
      "The selected loopback port is unavailable. Choose another allowed port.",
    );
    return 1;
  }
  try {
    const launch = options.spawnChild ?? spawn;
    const child = launch(
      process.execPath,
      [cli, "start", "--hostname", releaseHost, "--port", String(port)],
      {
        cwd: root,
        env,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    const result = waitForOwnedChild(child, report);
    report(
      "Staging-demo configuration validated. Verify the catalog separately; liveness is not readiness.",
    );
    return result;
  } catch {
    report(
      "Could not start the staging demonstration server. Check the build and port, then try again.",
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(entry)) {
  process.exitCode = await runRelease(process.argv.slice(2), process.env).catch(
    () => {
      console.error("The release launcher could not complete its checks.");
      return 1;
    },
  );
}
