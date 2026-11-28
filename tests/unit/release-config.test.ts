import {
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncReturns,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runRelease } from "../../scripts/start-release";
import {
  evaluateReleaseConfig,
  type ReleaseEnvironment,
} from "../../src/server/release-config";

const demo = ["staging-demo"];
const fixture = { DATA_SOURCE: "fixture" };
const blankDatabase = {
  DATABASE_URL: "",
  TEST_DATABASE_URL: "",
  BOOKSTORE_LOCAL_DB_READS: "",
};
const blocked = "synthetic-private-value-never-echo";
const buildRequired = /usable production build/i;
const badIntent = /exact positional release intent/i;
const realDenied = /not authorized/i;
const badSource = /explicitly to fixture/i;
const badPort = /decimal port/i;
const badArgument = /optional --port/i;
const requireFromTest = createRequire(import.meta.url);
const systemEnv =
  process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {};

async function withRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "bookstore-release-unit-"));
  try {
    return await callback(root);
  } finally {
    // Only remove the path returned by this test's mkdtemp.
    await rm(root, { recursive: true, force: true });
  }
}

async function writeFixtureFiles(
  root: string,
  files: Record<string, string | undefined>,
) {
  for (const [name, value] of Object.entries(files)) {
    if (value === undefined) continue;
    const file = join(root, name);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, value, "utf8");
  }
}

const nextBin = "node_modules/next/dist/bin/next";
const buildId = ".next/BUILD_ID";
const routes = ".next/routes-manifest.json";
const prerender = ".next/prerender-manifest.json";
const required = ".next/required-server-files.json";
const paths = ".next/server/app-paths-manifest.json";
const catalogArtifact = ".next/server/app/catalog/page.js";
const validBuild = {
  [nextBin]: "// synthetic Next CLI; intercepted by the spawn mock\n",
  [buildId]: "test-build_01\n",
  [routes]: '{"version":3,"staticRoutes":[],"dynamicRoutes":[]}',
  [prerender]: '{"version":4,"routes":{},"dynamicRoutes":{}}',
  [required]:
    '{"version":1,"config":{"distDir":".next"},"files":[".next/BUILD_ID"]}',
  [paths]: '{"/catalog/page":"app/catalog/page.js"}',
  [catalogArtifact]: "// synthetic catalog artifact\n",
};

async function bindOwnedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  return server;
}

function closeOwnedPort(server: ReturnType<typeof createServer>) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function availablePortValue() {
  const server = await bindOwnedPort();
  let port: number;
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP address");
    port = address.port;
  } finally {
    await closeOwnedPort(server);
  }
  return `--port=${port}`;
}

function noChild() {
  return vi.fn((): ChildProcess => {
    throw new Error("Unexpected child launch");
  });
}

const sanitizedChild = {
  DATA_SOURCE: "fixture",
  ...blankDatabase,
  NODE_ENV: "production",
};

interface Denial {
  name: string;
  args: readonly string[];
  env: ReleaseEnvironment;
  diagnostic: RegExp;
}

const denials: Denial[] = [
  { name: "missing intent", args: [], env: fixture, diagnostic: badIntent },
  {
    name: "unknown intent",
    args: [blocked],
    env: fixture,
    diagnostic: badIntent,
  },
  {
    name: "wrong-case intent",
    args: ["Staging-Demo"],
    env: fixture,
    diagnostic: badIntent,
  },
  {
    name: "flag-form intent",
    args: ["--intent=staging-demo"],
    env: fixture,
    diagnostic: badIntent,
  },
  { name: "missing source", args: demo, env: {}, diagnostic: badSource },
  {
    name: "empty source",
    args: demo,
    env: { DATA_SOURCE: "" },
    diagnostic: badSource,
  },
  {
    name: "whitespace source",
    args: demo,
    env: { DATA_SOURCE: " \t" },
    diagnostic: badSource,
  },
  {
    name: "invalid source",
    args: demo,
    env: { DATA_SOURCE: blocked },
    diagnostic: badSource,
  },
  {
    name: "wrong-case source value",
    args: demo,
    env: { DATA_SOURCE: "FIXTURE" },
    diagnostic: badSource,
  },
  {
    name: "wrong-case source key",
    args: demo,
    env: { data_source: "fixture" },
    diagnostic: badSource,
  },
  {
    name: "ambiguous source keys",
    args: demo,
    env: { ...fixture, data_source: blocked },
    diagnostic: badSource,
  },
  {
    name: "explicit database source",
    args: demo,
    env: { DATA_SOURCE: "database" },
    diagnostic: badSource,
  },
  ...Object.keys(blankDatabase).flatMap((key) => [
    {
      name: `nonempty ${key}`,
      args: demo,
      env: { ...fixture, [key]: blocked },
      diagnostic: new RegExp(key),
    },
    {
      name: `whitespace-only ${key}`,
      args: demo,
      env: { ...fixture, [key]: " \t" },
      diagnostic: new RegExp(key),
    },
    {
      name: `case-variant ${key}`,
      args: demo,
      env: { ...fixture, [key.toLowerCase()]: blocked },
      diagnostic: new RegExp(key),
    },
  ]),
  ...["staging-real", "production-real"].flatMap((intent) => [
    {
      name: `${intent} with no source`,
      args: [intent],
      env: {},
      diagnostic: realDenied,
    },
    {
      name: `${intent} with fixture source`,
      args: [intent],
      env: fixture,
      diagnostic: realDenied,
    },
    {
      name: `${intent} with database source`,
      args: [intent],
      env: { DATA_SOURCE: "database" },
      diagnostic: realDenied,
    },
    {
      name: `${intent} with plausible isolated database settings`,
      args: [intent, "--port=3002"],
      env: {
        DATA_SOURCE: "database",
        DATABASE_URL: `postgresql://bookstore_catalog:${blocked}@127.0.0.1:55432/bookstore_catalog_dev`,
        TEST_DATABASE_URL: `postgresql://bookstore_catalog:${blocked}@127.0.0.1:55433/bookstore_catalog_ci`,
        BOOKSTORE_LOCAL_DB_READS: "1",
      },
      diagnostic: realDenied,
    },
  ]),
  ...[
    "",
    "0",
    "1023",
    "3000",
    "65536",
    "655350",
    "+3002",
    "-3002",
    "03002",
    "3002.0",
    "3e3",
    "0xbbb",
    " 3002",
    "3002 ",
    "3002\n",
    blocked,
  ].map((value) => ({
    name: `bad port #${JSON.stringify(value === blocked ? "text" : value)}`,
    args: [...demo, `--port=${value}`],
    env: fixture,
    diagnostic: badPort,
  })),
  {
    name: "Next-reserved port",
    args: [...demo, "--port=6000"],
    env: fixture,
    diagnostic: /reserved by Next/i,
  },
  {
    name: "separate port argument",
    args: [...demo, "--port", "3002"],
    env: fixture,
    diagnostic: badArgument,
  },
  {
    name: "host override",
    args: [...demo, "--hostname=0.0.0.0"],
    env: fixture,
    diagnostic: badArgument,
  },
  {
    name: "unsupported flag",
    args: [...demo, "--some-other-option"],
    env: fixture,
    diagnostic: badArgument,
  },
  {
    name: "extra positional argument",
    args: [...demo, "--port=3002", blocked],
    env: fixture,
    diagnostic: badArgument,
  },
  {
    name: "repeated port",
    args: [...demo, "--port=3002", "--port=3003"],
    env: fixture,
    diagnostic: badArgument,
  },
];

describe("release policy and launch rejection", () => {
  let emptyRoot: string;
  beforeAll(async () => {
    emptyRoot = await mkdtemp(join(tmpdir(), "bookstore-release-reject-"));
  });
  afterAll(async () => {
    if (emptyRoot) await rm(emptyRoot, { recursive: true, force: true });
  });

  it.each(denials)(
    "rejects $name before build checks or spawning",
    async ({ args, env, diagnostic }) => {
      const policy = evaluateReleaseConfig(args, env);
      expect(policy).toEqual({
        ok: false,
        message: expect.stringMatching(diagnostic),
      });
      const spawnChild = noChild();
      const report = vi.fn<(message: string) => void>();
      expect(
        await runRelease(args, env, { root: emptyRoot, spawnChild, report }),
      ).toBe(1);
      expect(spawnChild).not.toHaveBeenCalled();
      expect(report).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(diagnostic),
      );
      expect(JSON.stringify([policy, report.mock.calls])).not.toContain(
        blocked,
      );
    },
  );

  it.each([
    {
      name: "absent database settings and default port",
      args: demo,
      env: fixture,
      port: 3001,
    },
    {
      name: "empty database settings and alternate port",
      args: [...demo, "--port=3002"],
      env: { ...fixture, ...blankDatabase },
      port: 3002,
    },
    {
      name: "minimum port",
      args: [...demo, "--port=1024"],
      env: fixture,
      port: 1024,
    },
    {
      name: "maximum port",
      args: [...demo, "--port=65535"],
      env: fixture,
      port: 65535,
    },
  ])("accepts $name", ({ args, env, port }) => {
    expect(evaluateReleaseConfig(args, env)).toEqual({
      ok: true,
      config: { port, env: sanitizedChild },
    });
  });
});

describe("release launcher preflight", () => {
  const badArtifacts = [
    ...Object.keys(validBuild).map((file) => ({
      name: `missing ${file}`,
      overrides: { [file]: undefined },
    })),
    { name: "empty build ID", overrides: { [buildId]: "" } },
    {
      name: "malformed build ID",
      overrides: { [buildId]: blocked + "/invalid" },
    },
    { name: "malformed manifest", overrides: { [routes]: `{ ${blocked}` } },
    { name: "array manifest", overrides: { [prerender]: "[]" } },
    { name: "null manifest", overrides: { [required]: "null" } },
    { name: "missing catalog route mapping", overrides: { [paths]: "{}" } },
    {
      name: "wrong catalog route mapping",
      overrides: { [paths]: '{"/catalog/page":"app/other/page.js"}' },
    },
    { name: "empty catalog artifact", overrides: { [catalogArtifact]: "" } },
    { name: "empty Next executable", overrides: { [nextBin]: "" } },
  ];

  it.each(badArtifacts)(
    "refuses $name without a child",
    async ({ overrides }) => {
      await withRoot(async (root) => {
        await writeFixtureFiles(root, { ...validBuild, ...overrides });
        const spawnChild = noChild();
        const report = vi.fn<(message: string) => void>();
        expect(
          await runRelease(demo, fixture, { root, spawnChild, report }),
        ).toBe(1);
        expect(spawnChild).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(buildRequired),
        );
        expect(JSON.stringify(report.mock.calls)).not.toContain(blocked);
      });
    },
  );

  it("refuses an occupied loopback port without stopping its owner or spawning", async () => {
    await withRoot(async (root) => {
      await writeFixtureFiles(root, validBuild);
      const server = await bindOwnedPort();
      try {
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected TCP address");
        const spawnChild = noChild();
        const report = vi.fn<(message: string) => void>();
        expect(
          await runRelease([...demo, `--port=${address.port}`], fixture, {
            root,
            spawnChild,
            report,
          }),
        ).toBe(1);
        expect(spawnChild).not.toHaveBeenCalled();
        expect(report).toHaveBeenCalledExactlyOnceWith(
          expect.stringMatching(/loopback port is unavailable/i),
        );
        expect(server.listening).toBe(true);
        expect(server.address()).toEqual(address);
      } finally {
        await closeOwnedPort(server);
      }
    });
  });
});

function syntheticChild(onReturn: (child: EventEmitter) => void) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => true),
  });
  const spawnChild = vi.fn((...args: [string, string[], SpawnOptions]) => {
    void args;
    queueMicrotask(() => onReturn(child));
    return child as unknown as ChildProcess;
  });
  return { spawnChild, child };
}

function assertNodeSucceeded(result: SpawnSyncReturns<string>) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
}

describe("release launch and actual process boundaries", () => {
  it("passes exact loopback argv and keeps actual Next dotenv inputs inert", async () => {
    await withRoot(async (root) => {
      await writeFixtureFiles(root, {
        ...validBuild,
        ".env": "BOOKSTORE_LOCAL_DB_READS=1\n",
        ".env.local": "TEST_DATABASE_URL=dotenv-test-db-sentinel\n",
        ".env.production": "DATABASE_URL=dotenv-base-db-sentinel\n",
        ".env.production.local":
          "DATA_SOURCE=database\nDATABASE_URL=dotenv-production-db-sentinel\nRELEASE_DOTENV_PROBE=loaded\n",
      });
      const inherited = Object.freeze({
        ...systemEnv,
        ...fixture,
        ...blankDatabase,
        bookStore_local_db_reads: "",
        NODE_ENV: "development",
        NODE_OPTIONS: blocked,
        node_options: blocked,
        NODE_PATH: blocked,
        PORT: "3000",
        HOSTNAME: "0.0.0.0",
        __NEXT_PRIVATE_STANDALONE_CONFIG: blocked,
        RELEASE_TEST_MARKER: "kept",
      });
      const { spawnChild } = syntheticChild((child) =>
        child.emit("close", 0, null),
      );
      const report = vi.fn<(message: string) => void>();
      const portArg = await availablePortValue();
      expect(
        await runRelease([...demo, portArg], inherited, {
          root,
          spawnChild,
          report,
        }),
      ).toBe(0);
      const expectedEnv = {
        ...systemEnv,
        ...sanitizedChild,
        RELEASE_TEST_MARKER: "kept",
      };
      expect(spawnChild).toHaveBeenCalledExactlyOnceWith(
        process.execPath,
        [
          join(root, nextBin),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          portArg.slice("--port=".length),
        ],
        expect.objectContaining({ cwd: root, shell: false, env: expectedEnv }),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(blocked);
      expect(inherited.NODE_OPTIONS).toBe(blocked);

      const nextRequire = createRequire(
        requireFromTest.resolve("next/package.json"),
      );
      const probe = `
        const { loadEnvConfig } = require(process.argv[1]);
        loadEnvConfig(process.cwd(), false);
        const keys = ["DATA_SOURCE", "DATABASE_URL", "TEST_DATABASE_URL", "BOOKSTORE_LOCAL_DB_READS", "RELEASE_DOTENV_PROBE"];
        process.stdout.write(JSON.stringify(Object.fromEntries(keys.map(key => [key, process.env[key]]))));
      `;
      function readNextEnv(env: SpawnOptions["env"]) {
        const result = spawnSync(
          process.execPath,
          ["-e", probe, nextRequire.resolve("@next/env")],
          {
            cwd: root,
            env,
            encoding: "utf8",
            shell: false,
            timeout: 10000,
          },
        );
        assertNodeSucceeded(result);
        return JSON.parse(result.stdout) as Record<string, string>;
      }
      // A separate process without guard values proves that the files and
      // real production-mode loader would otherwise supply all four inputs.
      expect(readNextEnv({ ...systemEnv, NODE_ENV: "production" })).toEqual({
        DATA_SOURCE: "database",
        DATABASE_URL: "dotenv-production-db-sentinel",
        TEST_DATABASE_URL: "dotenv-test-db-sentinel",
        BOOKSTORE_LOCAL_DB_READS: "1",
        RELEASE_DOTENV_PROBE: "loaded",
      });
      expect(readNextEnv(spawnChild.mock.calls[0][2].env)).toEqual({
        ...fixture,
        ...blankDatabase,
        RELEASE_DOTENV_PROBE: "loaded",
      });
    });
  }, 20000);

  const cliCases = [
    { name: "dotenv-only source", args: demo, env: {}, diagnostic: badSource },
    {
      name: "production intent",
      args: ["production-real"],
      env: { DATA_SOURCE: "database", DATABASE_URL: blocked },
      diagnostic: realDenied,
    },
    {
      name: "inherited database input",
      args: demo,
      env: { ...fixture, TEST_DATABASE_URL: blocked },
      diagnostic: /TEST_DATABASE_URL/,
    },
    {
      name: "unsupported port",
      args: [...demo, `--port=${blocked}`],
      env: fixture,
      diagnostic: badPort,
    },
  ];

  it.each(cliCases)(
    "rejects $name through the actual shell-free CLI",
    async ({ args, env, diagnostic }) => {
      await withRoot(async (root) => {
        await writeFixtureFiles(root, {
          ".env.production.local": "DATA_SOURCE=fixture\n",
        });
        const cli = fileURLToPath(
          new URL("../../scripts/start-release.ts", import.meta.url),
        );
        const tsx = pathToFileURL(requireFromTest.resolve("tsx")).href;
        const result = spawnSync(
          process.execPath,
          ["--import", tsx, cli, ...args],
          {
            cwd: root,
            env: { ...systemEnv, NODE_ENV: "production", ...env },
            encoding: "utf8",
            shell: false,
            timeout: 10000,
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.status).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trim()).toMatch(diagnostic);
        expect(result.stderr).not.toContain(blocked);
      });
    },
    20000,
  );

  it.each([
    { code: 7, signal: null, failed: false, expected: 7 },
    { code: null, signal: "SIGINT", failed: false, expected: 130 },
    { code: null, signal: "SIGTERM", failed: false, expected: 143 },
    { code: null, signal: null, failed: true, expected: 1 },
  ])(
    "preserves child failure status $expected with no raw error echo",
    async ({ code, signal, failed, expected }) => {
      await withRoot(async (root) => {
        await writeFixtureFiles(root, validBuild);
        const { spawnChild } = syntheticChild((child) => {
          if (failed) child.emit("error", new Error(blocked));
          child.emit("close", code, signal);
        });
        const report = vi.fn<(message: string) => void>();
        expect(
          await runRelease([...demo, await availablePortValue()], fixture, {
            root,
            spawnChild,
            report,
          }),
        ).toBe(expected);
        expect(spawnChild).toHaveBeenCalledOnce();
        expect(report).toHaveBeenCalledWith(
          expect.stringMatching(/stopped with an error/i),
        );
        expect(JSON.stringify(report.mock.calls)).not.toContain(blocked);
      });
    },
  );

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "forwards %s once to its own child and removes its handlers",
    async (signal, status) => {
      await withRoot(async (root) => {
        await writeFixtureFiles(root, validBuild);
        const listenersBefore = process.listeners(signal);
        const { child, spawnChild } = syntheticChild((emitter) => {
          // Invoke only the launcher's newly registered listener, never signal
          // the test runner or any real process. Two calls exercise idempotence.
          for (const listener of process.listeners(signal)) {
            if (!listenersBefore.includes(listener)) {
              listener(signal);
              listener(signal);
            }
          }
          emitter.emit("close", 0, null);
        });
        expect(
          await runRelease([...demo, await availablePortValue()], fixture, {
            root,
            spawnChild,
            report: vi.fn(),
          }),
        ).toBe(status);
        expect(child.kill).toHaveBeenCalledExactlyOnceWith(signal);
        expect(process.listeners(signal)).toEqual(listenersBefore);
      });
    },
  );
});
