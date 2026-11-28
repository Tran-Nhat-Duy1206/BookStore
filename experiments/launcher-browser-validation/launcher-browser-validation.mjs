import { spawn, execFileSync } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const APP_SHA = "0e0bba8dac9fba8f624e7d217ffdb282ca9e987f";
const MERGE_SHA = "7c1dd316cefa634d5291c0cb36fe19aee345e8bf";
const TREE = "6c628a6eb860ea7461b603fd00082136e76af506";
const APP = await realpath(process.cwd());
const cli = join(APP, "scripts/start-release.ts");
const next = join(APP, "node_modules/next/dist/bin/next");
const req = createRequire(join(APP, "package.json"));
const evidence = {
  application: APP_SHA,
  mergeBaseline: MERGE_SHA,
  tree: TREE,
  experiment: null,
  environment: {},
  linux: {},
  cleanup: [],
  errors: [],
};
const groups = new Set();
const host = "127.0.0.1";
let scratch, output, interrupted;
const env = Object.fromEntries(
  [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "CI",
    "TMPDIR",
    "RUNNER_TEMP",
    "PLAYWRIGHT_BROWSERS_PATH",
    "XDG_CACHE_HOME",
    "LD_LIBRARY_PATH",
  ]
    .filter((k) => process.env[k] !== undefined)
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  DATA_SOURCE: "fixture",
  DATABASE_URL: "",
  TEST_DATABASE_URL: "",
  BOOKSTORE_LOCAL_DB_READS: "",
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
});
const invariant = (ok, code) => {
  if (!ok) throw new Check(code);
};
class Check extends Error {}
function safe(error) {
  return error instanceof Check
    ? error.message
    : error?.name === "TimeoutError"
      ? "operation-timeout"
      : "unexpected-operation";
}
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Check(code)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const shutdown = new AbortController();
const onSignal = (signal) => {
  interrupted = signal;
  shutdown.abort();
};
process.on("SIGTERM", () => onSignal("SIGTERM"));
process.on("SIGINT", () => onSignal("SIGINT"));
function git(root, ...args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: 4000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}
function launch(command, args, { cwd = APP, overrides = {} } = {}) {
  invariant(!interrupted, "harness-interrupted");
  const child = spawn(command, args, {
    cwd,
    env: { ...env, ...overrides },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    overflow = false;
  for (const [stream, save] of [
    [
      child.stdout,
      (s) => {
        stdout += s;
      },
    ],
    [
      child.stderr,
      (s) => {
        stderr += s;
      },
    ],
  ])
    stream.on("data", (b) => {
      if (stdout.length + stderr.length + b.length > 65536) overflow = true;
      if (!overflow) save(b.toString("utf8"));
    });
  let spawnError = false;
  child.once("error", () => {
    spawnError = true;
  });
  const done = new Promise((resolve) =>
    child.once("close", (code, signal) =>
      resolve({ code, signal, spawnError, stdout, stderr, overflow }),
    ),
  );
  const owned = {
    child,
    done,
    rootIdentity: child.pid ? identity(child.pid) : Promise.resolve(null),
    known: [],
  };
  groups.add(owned);
  return owned;
}
async function identity(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    if (fields[0] === "Z") return null;
    return {
      pid: Number(pid),
      ppid: Number(fields[1]),
      group: Number(fields[2]),
      startTicks: fields[19],
    };
  } catch {
    return null;
  }
}
async function same(id) {
  return Boolean(id && (await identity(id.pid))?.startTicks === id.startTicks);
}
async function groupMembers(id) {
  const list = await readdir("/proc");
  const members = await Promise.all(
    list.filter((k) => /^\d+$/.test(k)).map(identity),
  );
  return members.filter((p) => p && p.group === id);
}
async function waitUntil(fn, ms, code) {
  const until = Date.now() + ms;
  while (Date.now() < until && !interrupted) {
    const result = await fn();
    if (result) return result;
    await pause(80);
  }
  throw new Check(interrupted ? "harness-interrupted" : code);
}
async function cleanupGroup(owned) {
  if (!owned.child.pid) {
    await bounded(owned.done, 3000, "spawn-close-timeout");
    groups.delete(owned);
    return;
  }
  const pgid = owned.child.pid;
  const members = await groupMembers(pgid);
  // This group was created by detached:true for this owned spawn; do not signal by name/port.
  if (members.length) {
    const known = [await owned.rootIdentity, ...owned.known].filter(Boolean);
    invariant(
      members.some((p) =>
        known.some((k) => p.pid === k.pid && p.startTicks === k.startTicks),
      ),
      "group-ownership-unproved",
    );
    try {
      process.kill(-pgid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && (await groupMembers(pgid)).length)
      await pause(70);
    const rest = await groupMembers(pgid);
    if (rest.length) {
      invariant(
        rest.some((p) =>
          members.some((k) => p.pid === k.pid && p.startTicks === k.startTicks),
        ),
        "group-ownership-lost-before-escalation",
      );
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }
  await bounded(owned.done, 4000, "owned-group-close-timeout");
  invariant(!(await groupMembers(pgid)).length, "owned-group-remains");
  groups.delete(owned);
}
async function free(port) {
  return new Promise((resolve) => {
    const socket = createServer();
    socket.once("error", () => resolve(false));
    socket.listen({ host, port, exclusive: true }, () =>
      socket.close((error) => resolve(!error)),
    );
  });
}
async function choose(ports) {
  for (const p of ports) if (await free(p)) return p;
  throw new Check("no-approved-loopback-port-free");
}
async function ownedListener(owned, port) {
  const inodes = [];
  const sockets = [];
  for (const proto of ["tcp", "tcp6"])
    for (const line of (await readFile(`/proc/net/${proto}`, "utf8"))
      .trim()
      .split("\n")
      .slice(1)) {
      const f = line.trim().split(/\s+/);
      const [address, hex] = f[1].split(":");
      if (parseInt(hex, 16) === port && f[3] === "0A") {
        inodes.push(f[9]);
        sockets.push({ proto, address });
      }
    }
  if (!inodes.length) return null;
  invariant(
    inodes.length === 1 &&
      sockets[0].proto === "tcp" &&
      sockets[0].address === "0100007F",
    "unexpected-listener-address",
  );
  const members = await groupMembers(owned.child.pid);
  const { readlink } = await import("node:fs/promises");
  const owners = [];
  for (const id of members) {
    const dir = `/proc/${id.pid}/fd`;
    const links = await readdir(dir)
      .then((files) =>
        Promise.all(
          files.map((fd) => readlink(`${dir}/${fd}`).catch(() => "")),
        ),
      )
      .catch(() => []);
    if (links.includes(`socket:[${inodes[0]}]`)) owners.push(id);
  }
  invariant(owners.length === 1, "listener-not-exclusively-owned");
  return { host, port, inode: inodes[0], next: owners[0], members };
}
const qualified = "/catalog?q=Lam+Kh%C3%AA&category=light-novel&sort=title";
const product = "/products/unknown-launcher-validation-product";
const series = "/series/unknown-launcher-validation-series";
async function document(origin, path) {
  const res = await fetch(origin + path, {
    signal: AbortSignal.timeout(4500),
    redirect: "manual",
  });
  return { status: res.status, body: await res.text() };
}
async function ready(owned, port, withLauncher) {
  const listener = await waitUntil(
    async () => {
      invariant(
        owned.child.exitCode === null && owned.child.signalCode === null,
        "process-exited-before-bind",
      );
      return ownedListener(owned, port);
    },
    15000,
    "listener-timeout",
  );
  owned.known = listener.members;
  const ownedRoot = await owned.rootIdentity;
  invariant(await same(ownedRoot), "owned-root-identity-lost");
  const chain = [listener.next];
  while (chain.at(-1).pid !== ownedRoot.pid) {
    const parent = await identity(chain.at(-1).ppid);
    invariant(
      parent?.group === ownedRoot.pid &&
        chain.length < 12 &&
        !chain.some((p) => p.pid === parent.pid),
      "listener-ancestry-unproved",
    );
    chain.push(parent);
  }
  invariant(
    chain.at(-1).startTicks === ownedRoot.startTicks,
    "listener-root-start-mismatch",
  );
  owned.known = listener.members;
  const launcher = withLauncher ? chain[1] : null;
  if (withLauncher) {
    invariant(
      launcher?.group === owned.child.pid && launcher.pid !== listener.next.pid,
      "next-parent-not-owned-launcher",
    );
    const cmd = await readFile(`/proc/${launcher.pid}/cmdline`, "utf8");
    invariant(
      cmd.split("\0").some((arg) => arg.endsWith("scripts/start-release.ts")),
      "next-parent-not-release-entrypoint",
    );
  }
  const origin = `http://${host}:${port}`;
  const { status, body } = await document(origin, qualified);
  invariant(
    status === 200 &&
      body.includes("Cá Tỏ BookStore") &&
      body.includes("Người giữ những vì sao") &&
      body.includes("Tiệm trà cuối chân trời") &&
      /hư cấu/i.test(body) &&
      /Chưa mở bán/i.test(body),
    "catalog-readiness-content",
  );
  const p = await document(origin, product),
    s = await document(origin, series);
  invariant(p.status === 404 && s.status === 404, "unknown-document-status");
  return {
    origin,
    catalog: {
      path: qualified,
      status,
      bookTitles: ["Người giữ những vì sao", "Tiệm trà cuối chân trời"],
      fictionAndBrand: true,
    },
    unknown: [
      { path: product, status: p.status },
      { path: series, status: s.status },
    ],
    binding: listener,
    launcher,
    ancestry: chain,
  };
}
async function signalCase(signal) {
  const item = (evidence.linux[signal] = { status: "FAIL" });
  const port = await choose([3001, 3002, 3102]);
  const owned = launch("pnpm", [
    "exec",
    "tsx",
    "scripts/start-release.ts",
    "staging-demo",
    ...(port === 3001 ? [] : [`--port=${port}`]),
  ]);
  try {
    const proof = await ready(owned, port, true);
    Object.assign(item, proof);
    invariant(
      await same(proof.launcher),
      "launcher-identity-changed-before-signal",
    );
    process.kill(proof.launcher.pid, signal);
    item.delivered = signal;
    const receipt = await bounded(
      owned.done,
      10000,
      "launcher-signal-exit-timeout",
    );
    item.exit = { code: receipt.code, signal: receipt.signal };
    invariant(
      receipt.code === (signal === "SIGINT" ? 130 : 143) &&
        receipt.signal === null,
      "launcher-signal-unexpected-exit",
    );
    item.membersTerminated = await waitUntil(
      async () =>
        !(await groupMembers(owned.child.pid)).length &&
        !(await Promise.all(proof.binding.members.map(same))).some(Boolean),
      3500,
      "launcher-descendants-remain",
    );
    item.portReleased = await free(port);
    invariant(item.portReleased, "launcher-port-not-released");
    item.status = "PASS";
  } finally {
    await cleanupGroup(owned);
    item.explicitCleanup = true;
  }
}
async function rejectionCases() {
  const port = await choose([3001, 3002, 3102]);
  const sentinel = "SYNTHETIC_OPAQUE_VALUE_DO_NOT_RECORD";
  // Preload observes the actual CLI's child_process spawn boundary; append only a constant receipt.
  const hook = join(scratch, "observe-spawn.mjs");
  await writeFile(
    hook,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {appendFileSync} from 'node:fs';appendFileSync(process.env.PROBE_FILE,'hook-active\\n');cp.spawn=function(){appendFileSync(process.env.PROBE_FILE,'spawn-attempt-blocked\\n');throw new Error('Negative control blocked an unexpected spawn.');};syncBuiltinESMExports();`,
  );
  const expected = {
    "missing-intent":
      "Supply the exact positional release intent staging-demo.",
    "invalid-intent":
      "Supply the exact positional release intent staging-demo.",
    "missing-source":
      "Set inherited DATA_SOURCE explicitly to fixture for staging-demo.",
    "invalid-source":
      "Set inherited DATA_SOURCE explicitly to fixture for staging-demo.",
    "database-setting":
      "DATABASE_URL must be absent or empty for staging-demo.",
    "staging-real":
      "Real-content staging and production releases are not authorized.",
    "production-real":
      "Real-content staging and production releases are not authorized.",
    "disallowed-port":
      "Choose a decimal port from 1024 to 65535, excluding 3000.",
    "host-override": "Only the optional --port=<number> argument is supported.",
  };
  evidence.linux.rejections = [];
  for (const [name, args, overrides] of [
    ["missing-intent", [], {}],
    ["invalid-intent", [sentinel], {}],
    [
      "missing-source",
      ["staging-demo", `--port=${port}`],
      { DATA_SOURCE: undefined },
    ],
    [
      "invalid-source",
      ["staging-demo", `--port=${port}`],
      { DATA_SOURCE: sentinel },
    ],
    [
      "database-setting",
      ["staging-demo", `--port=${port}`],
      { DATABASE_URL: sentinel },
    ],
    [
      "staging-real",
      ["staging-real"],
      { DATA_SOURCE: "database", DATABASE_URL: sentinel },
    ],
    [
      "production-real",
      ["production-real"],
      { DATA_SOURCE: "database", DATABASE_URL: sentinel },
    ],
    ["disallowed-port", ["staging-demo", "--port=3000"], {}],
    ["host-override", ["staging-demo", "--hostname=0.0.0.0"], {}],
  ]) {
    const item = { name, status: "FAIL" };
    evidence.linux.rejections.push(item);
    const file = join(scratch, `negative-${name}`);
    const owned = launch(
      process.execPath,
      ["--import", "tsx", "--import", pathToFileURL(hook).href, cli, ...args],
      { overrides: { ...overrides, PROBE_FILE: file } },
    );
    try {
      const result = await bounded(owned.done, 8000, "negative-exit-timeout");
      item.exit = result.code;
      item.hookActiveAndNoSpawn =
        (await readFile(file, "utf8")) === "hook-active\n";
      item.publicDiagnosticRedacted =
        !result.overflow &&
        !`${result.stdout}${result.stderr}`.includes(sentinel);
      item.portFree = await free(port);
      item.expectedDiagnostic =
        result.stdout === "" && result.stderr.trim() === expected[name];
      invariant(
        result.code === 1 &&
          result.signal === null &&
          !result.spawnError &&
          item.expectedDiagnostic &&
          item.hookActiveAndNoSpawn &&
          item.publicDiagnosticRedacted &&
          item.portFree,
        "negative-control-not-proved",
      );
      item.status = "PASS";
    } catch (error) {
      item.error = safe(error);
    } finally {
      await cleanupGroup(owned);
    }
  }
}
async function instrumentedFailure() {
  const item = (evidence.linux.instrumentedStartupFailure = { status: "FAIL" });
  const port = await choose([3001, 3002, 3102]);
  const root = join(scratch, "fault-build");
  await mkdir(root);
  await cp(join(APP, ".next"), join(root, ".next"), {
    recursive: true,
    filter: (p) =>
      p === join(APP, ".next") ||
      !["dev", "cache"].includes(
        relative(join(APP, ".next"), p).split(/[\\/]/, 1)[0],
      ),
  });
  await symlink(join(APP, "node_modules"), join(root, "node_modules"), "dir");
  const resultFile = join(scratch, "failure-receipt.json");
  const hook = join(scratch, "instrumented-failure.mjs");
  await writeFile(
    hook,
    `import {spawn} from 'node:child_process';import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {runRelease} from ${JSON.stringify(pathToFileURL(cli).href)};const root=${JSON.stringify(root)};const path=join(root,'.next','BUILD_ID'),held=path+'.held';const receipt={preflightPassed:false,realChildInvoked:false,buildUnavailableBeforeSpawn:false,childReportedMissingProductionBuild:false,restored:false};let rotated=false;try{const original=readFileSync(path);receipt.exit=await runRelease(['staging-demo','--port=${port}'],process.env,{root,report:()=>{},spawnChild:(command,args,options)=>{receipt.preflightPassed=true;renameSync(path,held);rotated=true;receipt.buildUnavailableBeforeSpawn=!existsSync(path);const child=spawn(command,args,{...options,stdio:['ignore','ignore','pipe']});receipt.childPid=child.pid??null;let scan='';child.stderr.on('data',chunk=>{scan=(scan+chunk.toString('utf8')).slice(-65536);receipt.childReportedMissingProductionBuild||=/could not find a production build/i.test(scan);});child.once('spawn',()=>{receipt.realChildInvoked=true;});child.once('close',(code,signal)=>{receipt.childExit=code;receipt.childSignal=signal;});return child;}});if(rotated){renameSync(held,path);rotated=false;}receipt.restored=readFileSync(path).equals(original);}finally{if(rotated)renameSync(held,path);writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(receipt),{mode:0o600});}process.exitCode=receipt.exit??1;`,
  );
  const owned = launch(process.execPath, ["--import", "tsx", hook]);
  try {
    const result = await bounded(
      owned.done,
      15000,
      "instrumented-failure-timeout",
    );
    const data = JSON.parse(await readFile(resultFile, "utf8"));
    for (const field of [
      "preflightPassed",
      "realChildInvoked",
      "buildUnavailableBeforeSpawn",
      "childReportedMissingProductionBuild",
      "restored",
    ])
      item[field] = data[field] === true;
    for (const field of ["exit", "childPid", "childExit"])
      item[field] = Number.isInteger(data[field]) ? data[field] : null;
    item.childSignal = ["SIGINT", "SIGTERM", "SIGKILL"].includes(
      data.childSignal,
    )
      ? data.childSignal
      : null;
    item.portReleased = await free(port);
    item.groupEmpty = !(await groupMembers(owned.child.pid)).length;
    invariant(
      data.preflightPassed &&
        data.realChildInvoked &&
        data.buildUnavailableBeforeSpawn &&
        data.childReportedMissingProductionBuild &&
        data.restored &&
        data.childExit > 0 &&
        data.exit === data.childExit &&
        result.code === data.exit &&
        item.portReleased &&
        item.groupEmpty,
      "instrumented-next-startup-failure-not-proved",
    );
    item.status = "PASS";
  } finally {
    await cleanupGroup(owned);
    item.explicitCleanup = true;
  }
}
async function run() {
  const temp = await realpath(process.env.RUNNER_TEMP);
  invariant(
    process.platform === "linux" &&
      process.env.GITHUB_ACTIONS === "true" &&
      process.env.RUNNER_ENVIRONMENT === "github-hosted" &&
      process.env.RUNNER_OS === "Linux",
    "runner-not-authorized",
  );
  const requested = resolve(process.env.EVIDENCE_DIR);
  invariant(
    requested === join(temp, "launcher-browser-validation", "evidence"),
    "unexpected-evidence-path",
  );
  await mkdir(requested, { mode: 0o700 });
  output = await realpath(requested);
  invariant(output === requested, "evidence-path-not-owned");
  scratch = await mkdtemp(join(temp, "launcher-browser-owned-"));
  evidence.experiment = process.env.EXPERIMENT_SHA;
  invariant(
    /^[0-9a-f]{40}$/.test(evidence.experiment) &&
      process.env.APP_SHA === APP_SHA,
    "sha-input-mismatch",
  );
  invariant(
    git(APP, "rev-parse", "HEAD") === APP_SHA &&
      git(APP, "rev-parse", "HEAD^{tree}") === TREE &&
      git(APP, "status", "--porcelain") === "",
    "application-checkout-mismatch",
  );
  const experiment = join(dirname(APP), "experiment");
  invariant(
    git(experiment, "rev-parse", "HEAD") === evidence.experiment &&
      git(experiment, "cat-file", "commit", "HEAD")
        .split("\n\n")[0]
        .split("\n")
        .filter((s) => s.startsWith("parent "))
        .join(" ") === `parent ${MERGE_SHA}`,
    "experiment-checkout-mismatch",
  );
  invariant(
    git(APP, "rev-parse", `${MERGE_SHA}^{tree}`) === TREE,
    "merged-tree-mismatch",
  );
  evidence.environment = {
    os: "Linux",
    runner: "GitHub hosted",
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], {
      encoding: "utf8",
      timeout: 6000,
    }).trim(),
    next: req("next/package.json").version,
    playwright: req("@playwright/test/package.json").version,
  };
  invariant(
    JSON.stringify([
      evidence.environment.node,
      evidence.environment.pnpm,
      evidence.environment.next,
      evidence.environment.playwright,
    ]) === JSON.stringify(["v24.19.0", "11.7.0", "16.4.5", "1.65.0"]),
    "runtime-version-mismatch",
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    try {
      await signalCase(signal);
    } catch (error) {
      evidence.linux[signal] ??= { status: "FAIL" };
      evidence.linux[signal].error = safe(error);
    }
  try {
    await rejectionCases();
  } catch (error) {
    evidence.errors.push({ stage: "launcher-rejections", code: safe(error) });
  }
  try {
    await instrumentedFailure();
  } catch (error) {
    evidence.linux.instrumentedStartupFailure ??= { status: "FAIL" };
    evidence.linux.instrumentedStartupFailure.error = safe(error);
  }
  const port = await choose([3001, 3002, 3102]);
  const failurePort = await choose([3101, 3103]);
  const healthy = launch("pnpm", [
    "exec",
    "tsx",
    "scripts/start-release.ts",
    "staging-demo",
    ...(port === 3001 ? [] : [`--port=${port}`]),
  ]);
  let failure;
  try {
    evidence.linux.browserStartup = await ready(healthy, port, true);
    const healthyOrigin = `http://${host}:${port}`,
      failureOrigin = `http://${host}:${failurePort}`;
    failure = launch(
      process.execPath,
      [next, "start", "--hostname", host, "--port", String(failurePort)],
      { overrides: { DATA_SOURCE: "invalid-source" } },
    );
    await waitUntil(
      () => ownedListener(failure, failurePort),
      15000,
      "compatibility-listener-timeout",
    );
    await browserMatrix(
      req("@playwright/test"),
      healthyOrigin,
      failureOrigin,
      evidence,
    );
  } finally {
    for (const [label, owned, p] of [
      ["compatibility-server", failure, failurePort],
      ["browser-launcher", healthy, port],
    ])
      if (owned) {
        try {
          await cleanupGroup(owned);
          invariant(await free(p), "browser-port-not-released");
          evidence.cleanup.push({ label, pass: true, port: p });
        } catch (error) {
          evidence.cleanup.push({ label, pass: false, code: safe(error) });
        }
      }
  }
}
async function main() {
  try {
    await run();
  } catch (error) {
    evidence.errors.push({ stage: "experiment", code: safe(error) });
  } finally {
    for (const owned of groups) {
      try {
        await cleanupGroup(owned);
        evidence.cleanup.push({ label: "remaining-owned-group", pass: true });
      } catch (error) {
        evidence.cleanup.push({
          label: "remaining-owned-group",
          pass: false,
          code: safe(error),
        });
      }
    }
    if (scratch) {
      try {
        const current = await realpath(scratch),
          metadata = await lstat(scratch);
        invariant(
          current === scratch &&
            metadata.isDirectory() &&
            dirname(scratch) === (await realpath(process.env.RUNNER_TEMP)),
          "scratch-ownership-lost",
        );
        await rm(scratch, { recursive: true, force: false });
        evidence.cleanup.push({
          label: "owned-temporary-directory",
          pass: true,
        });
      } catch (error) {
        evidence.cleanup.push({
          label: "owned-temporary-directory",
          pass: false,
          code: safe(error),
        });
      }
    }
    try {
      invariant(
        git(APP, "rev-parse", "HEAD") === APP_SHA &&
          git(APP, "status", "--porcelain") === "",
        "application-checkout-changed",
      );
      evidence.cleanup.push({ label: "app-checkout", pass: true });
    } catch (error) {
      evidence.cleanup.push({
        label: "app-checkout",
        pass: false,
        code: safe(error),
      });
    }
    const linux =
      ["SIGINT", "SIGTERM", "instrumentedStartupFailure"].every(
        (key) =>
          evidence.linux[key]?.status === "PASS" &&
          evidence.linux[key]?.explicitCleanup === true &&
          !evidence.linux[key]?.error,
      ) &&
      evidence.linux.rejections?.length === 9 &&
      evidence.linux.rejections.every((x) => x.status === "PASS") &&
      evidence.linux.browserStartup;
    const browser = Object.values(evidence.browser?.engines ?? {});
    const browserPass =
      browser.length === 3 && evidence.browser.status === "pass";
    evidence.result =
      !interrupted &&
      linux &&
      browserPass &&
      evidence.cleanup.every((x) => x.pass) &&
      !evidence.errors.length
        ? "PASS"
        : "FAIL";
    if (output)
      await writeFile(
        join(output, "evidence.json"),
        JSON.stringify(evidence, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
    console.log(`Launcher/browser validation: ${evidence.result}`);
    process.exitCode = evidence.result === "PASS" ? 0 : 1;
  }
}

// Browser-only fragment. Append this declaration to the owning fixture harness.
async function browserMatrix(
  browserTypes,
  healthyOrigin,
  failureOrigin,
  evidence,
) {
  const deadlineMs = 30000;
  const stepMs = 6000;
  const cleanupMs = 5000;
  const engines = ["chromium", "firefox", "webkit"];
  const results = (evidence.browser = {
    status: "blocked",
    caseDeadlineMs: deadlineMs,
    engines: {},
    counts: {},
    scope:
      "fixture engine automation; no physical-device or assistive-technology claim",
  });
  const blockedScript = /^\/_next\/static\/.*\.js$/i;
  const product = "/products/khu-vuon-sau-con-mua";
  const compareWith = "nhung-la-thu-gui-mua-thu";
  const filtered = "/catalog?q=Lam+Kh%C3%AA&category=light-novel&sort=title";
  const filteredTitles = ["Người giữ những vì sao", "Tiệm trà cuối chân trời"];
  const filteredSlugs = ["nguoi-giu-nhung-vi-sao", "tiem-tra-cuoi-chan-troi"];
  const seriesTitle = "Trạm dừng giữa những vì sao";
  const seriesPath = "/series/tram-dung-giua-nhung-vi-sao";
  const recoveryTitle = "Tạm thời chưa thể tải trang";
  const pendingText = "Đang đọc bộ sưu tập trên thiết bị này";
  const noScriptText = "Cần JavaScript để xem bộ sưu tập trên thiết bị.";
  const brand = "Cá Tỏ BookStore";
  class MatrixFault extends Error {
    constructor(code, status = "fail") {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  const requireThat = (condition, code) => {
    if (!condition) throw new MatrixFault(code);
  };
  const normalized = (value) => value.trim().replace(/\s+/g, " ");
  const exactTexts = (actual, expected) =>
    actual.length === expected.length &&
    actual.every((value, i) => normalized(value) === expected[i]);
  const limited = (work, ms, code) => {
    let timer;
    const alarm = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new MatrixFault(code)), ms);
    });
    return Promise.race([work, alarm]).finally(() => clearTimeout(timer));
  };
  async function untilShutdown(work) {
    let listener;
    const stop = new Promise((_, reject) => {
      listener = () =>
        reject(new MatrixFault("harness-interrupted", "blocked"));
      if (shutdown.signal.aborted) listener();
      else shutdown.signal.addEventListener("abort", listener, { once: true });
    });
    try {
      return await Promise.race([work, stop]);
    } finally {
      shutdown.signal.removeEventListener("abort", listener);
    }
  }
  const errorReceipt = (error) =>
    error instanceof MatrixFault
      ? { status: error.status, code: error.code }
      : {
          status: "fail",
          code:
            error?.name === "TimeoutError"
              ? "playwright-step-timeout"
              : "browser-operation-failed",
        };
  const parseOrigin = (value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" &&
        url.hostname === "127.0.0.1" &&
        url.port &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash
        ? url.origin
        : null;
    } catch {
      return null;
    }
  };
  const healthy = parseOrigin(healthyOrigin);
  const failing = parseOrigin(failureOrigin);
  if (!healthy || (failureOrigin && (!failing || failing === healthy))) {
    results.code = "invalid-or-nonisolated-origins";
    return results;
  }
  const abs = (path, origin = healthy) => new URL(path, origin).href;
  const at = (page, path, origin = healthy) =>
    page.waitForURL(abs(path, origin), {
      waitUntil: "domcontentloaded",
      timeout: stepMs,
    });
  const visible = (locator) =>
    locator.waitFor({ state: "visible", timeout: stepMs });
  const absent = (locator) =>
    locator.waitFor({ state: "detached", timeout: stepMs });
  const hidden = (locator) =>
    locator.waitFor({ state: "hidden", timeout: stepMs });
  const focused = async (locator, page, code) => {
    await visible(locator);
    const expected = await locator.elementHandle({ timeout: stepMs });
    try {
      await page.waitForFunction(
        (element) => document.activeElement === element,
        expected,
        { timeout: stepMs },
      );
      requireThat(
        await locator.evaluate((element) => document.activeElement === element),
        code,
      );
    } finally {
      await expected?.dispose();
    }
  };
  async function documentStatus(
    page,
    path,
    expected,
    result,
    key,
    origin = healthy,
  ) {
    const response = await page.goto(abs(path, origin), {
      waitUntil: "domcontentloaded",
      timeout: stepMs,
    });
    result[key] = response?.status() ?? null;
    requireThat(result[key] === expected, "unexpected-document-status");
    requireThat(
      page.url() === abs(path, origin),
      "unexpected-document-destination",
    );
    return response;
  }
  const getH1 = (page, name) =>
    page.getByRole("heading", {
      level: 1,
      name,
      exact: typeof name === "string",
    });
  const reflow = (page) =>
    page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      documentClientWidth: document.documentElement.clientWidth,
      horizontalOverflow:
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    }));
  const redacted = (value) =>
    !/postgres(?:ql)?:\/\/|source-smoke-sentinel|PrismaClient(?:KnownRequest|Initialization)Error|DATA_SOURCE must be exactly fixture or database|unused_source_smoke_database|source-smoke-canary|127\.0\.0\.1:1\/unused/i.test(
      value,
    );
  const noSubstitution = (value) =>
    !/Khu vườn sau cơn mưa|12 sách minh họa|Dạo quanh kệ sách/.test(value);
  async function inspectFailure(response, page) {
    const raw = await limited(
      response.text(),
      stepMs,
      "read-failure-document-timeout",
    );
    const rendered = await page.locator("body").innerText({ timeout: stepMs });
    requireThat(
      redacted(raw) && redacted(rendered),
      "failure-disclosure-detected",
    );
    requireThat(
      noSubstitution(raw) && noSubstitution(rendered),
      "failure-substituted-fixture",
    );
    return true;
  }
  async function catalogReceipt(page) {
    const cards = page.locator(".catalog-grid .book-card h3 a");
    await visible(cards.nth(1));
    requireThat(
      exactTexts(await cards.allTextContents(), filteredTitles),
      "filtered-books-mismatch",
    );
    for (const [i, slug] of filteredSlugs.entries())
      requireThat(
        (await cards.nth(i).getAttribute("href")) ===
          `/products/${slug}${new URL(filtered, healthy).search}`,
        "filtered-product-link-mismatch",
      );
    requireThat(
      (await page.locator("#catalog-query").inputValue()) === "Lam Khê" &&
        (await page.locator("#category").inputValue()) === "light-novel" &&
        (await page.locator("#sort").inputValue()) === "title",
      "filtered-control-state-mismatch",
    );
    requireThat(
      normalized(
        (await page.locator(".result-line span").textContent()) ?? "",
      ) === "2 sách minh họa cho “Lam Khê”",
      "filtered-count-mismatch",
    );
    return cards;
  }
  async function browseHome(page, result) {
    await documentStatus(page, "/", 200, result, "homeStatus");
    requireThat((await page.title()).startsWith(brand), "home-brand-missing");
    await visible(getH1(page, /Có một thế giới/));
    const link = page.getByRole("link", {
      name: "Dạo quanh kệ sách",
      exact: true,
    });
    requireThat(
      (await link.getAttribute("href")) === "/catalog",
      "home-catalog-destination-mismatch",
    );
    await Promise.all([at(page, "/catalog"), link.click()]);
    await visible(getH1(page, "Dạo quanh kệ sách"));
    await visible(page.locator(".catalog-grid .book-card").nth(11));
    requireThat(
      (await page.locator(".catalog-grid .book-card").count()) === 12,
      "home-catalog-book-count-mismatch",
    );
  }
  async function seriesOnly(page, result) {
    for (const query of [seriesTitle, "tram dung giua nhung vi sao"]) {
      await page.locator("#catalog-query").fill(query);
      const expected =
        "/catalog?" +
        new URLSearchParams({
          q: query,
          category: "all",
          sort: "default",
        }).toString();
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.url() === abs(expected) &&
            r.request().isNavigationRequest() &&
            r.request().resourceType() === "document" &&
            r.request().method() === "GET",
          { timeout: stepMs },
        ),
        at(page, expected),
        page.getByRole("button", { name: "Tìm & lọc", exact: true }).click(),
      ]);
      requireThat(
        response.status() === 200 && page.url() === abs(expected),
        "series-search-document-mismatch",
      );
      const region = page.getByRole("region", {
        name: "Bộ truyện phù hợp",
        exact: true,
      });
      await visible(
        region.getByRole("heading", {
          name: seriesTitle,
          level: 3,
          exact: true,
        }),
      );
      const match = region.getByRole("link");
      requireThat(
        (await match.count()) === 1 &&
          (await match.getAttribute("href")) === seriesPath,
        "series-match-destination-mismatch",
      );
      requireThat(
        (await page.locator(".catalog-grid").count()) === 0 &&
          normalized(
            (await page.locator(".result-line span").textContent()) ?? "",
          ) === `0 sách minh họa cho “${query}”`,
        "series-only-count-mismatch",
      );
      const recovery = page.getByRole("link", {
        name: "Trở lại tất cả sách",
        exact: true,
      });
      await visible(recovery);
      const [seriesBox, recoveryBox] = await Promise.all([
        match.boundingBox(),
        recovery.boundingBox(),
      ]);
      requireThat(
        seriesBox &&
          recoveryBox &&
          seriesBox.y < recoveryBox.y &&
          (await match.evaluate((el) =>
            Boolean(
              el.compareDocumentPosition(
                document.querySelector(".empty-state a"),
              ) & Node.DOCUMENT_POSITION_FOLLOWING,
            ),
          )),
        "series-priority-not-preserved",
      );
    }
    const match = page
      .getByRole("region", { name: "Bộ truyện phù hợp" })
      .getByRole("link");
    await Promise.all([at(page, seriesPath), match.click()]);
    await visible(getH1(page, seriesTitle));
    result.accentedAndUnaccentedMatched = true;
    result.seriesBeforeZeroBookRecovery = true;
  }
  async function compareNative(page, result) {
    await documentStatus(page, product, 200, result, "comparisonProductStatus");
    const select = page.getByLabel("Chọn sách cùng bộ để so sánh", {
      exact: true,
    });
    await select.selectOption(compareWith);
    const target = `/compare?book=khu-vuon-sau-con-mua&with=${compareWith}`;
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.url() === abs(target) &&
          r.request().isNavigationRequest() &&
          r.request().resourceType() === "document" &&
          r.request().method() === "GET",
        { timeout: stepMs },
      ),
      page.getByRole("button", { name: "So sánh sách", exact: true }).click(),
    ]);
    result.comparisonGetStatus = response.status();
    requireThat(response.status() === 200, "comparison-document-status");
    await at(page, target);
    const table = page.getByRole("table", { name: "Thông tin hai cuốn sách" });
    await visible(table);
    requireThat(
      exactTexts(await table.getByRole("columnheader").allTextContents(), [
        "Thông tin",
        "Khu vườn sau cơn mưa",
        "Những lá thư gửi mùa thu",
      ]),
      "comparison-column-order",
    );
    requireThat(
      (await table
        .getByRole("link", { name: "Những lá thư gửi mùa thu", exact: true })
        .getAttribute("href")) === `/products/${compareWith}`,
      "comparison-product-link-mismatch",
    );
  }
  const cases = [
    [
      "home-filtered-return-breadcrumb",
      {},
      async ({ page, result }) => {
        await browseHome(page, result);
        await page.locator("#catalog-query").fill("Lam Khê");
        await page.locator("#category").selectOption("light-novel");
        await page.locator("#sort").selectOption("title");
        await Promise.all([
          at(page, filtered),
          page.getByRole("button", { name: "Tìm & lọc", exact: true }).click(),
        ]);
        const cards = await catalogReceipt(page);
        const productPath = `/products/${filteredSlugs[0]}${new URL(filtered, healthy).search}`;
        await Promise.all([at(page, productPath), cards.first().click()]);
        await visible(getH1(page, filteredTitles[0]));
        const crumb = page.getByRole("navigation", {
          name: "Đường dẫn",
          exact: true,
        });
        requireThat(
          normalized(
            (await crumb.locator('[aria-current="page"]').textContent()) ?? "",
          ) === filteredTitles[0],
          "breadcrumb-current-page-mismatch",
        );
        const back = crumb.getByRole("link", {
          name: "Trở lại kết quả",
          exact: true,
        });
        const home = crumb.getByRole("link", {
          name: "Trang chủ",
          exact: true,
        });
        requireThat(
          (await back.getAttribute("href")) === filtered &&
            (await home.getAttribute("href")) === "/" &&
            (await crumb.locator('span[aria-hidden="true"]').count()) === 2,
          "breadcrumb-semantics-or-links-mismatch",
        );
        await home.focus();
        await page.keyboard.press("Tab");
        await focused(back, page, "breadcrumb-tab-focus-mismatch");
        requireThat(
          await back.evaluate(
            (el) => getComputedStyle(el).outlineStyle !== "none",
          ),
          "breadcrumb-outline-missing",
        );
        await Promise.all([at(page, filtered), page.keyboard.press("Enter")]);
        await catalogReceipt(page);
        result.orderedBookIdentities = filteredTitles;
        result.exactReturn = true;
      },
    ],
    [
      "series-only-search",
      { viewport: { width: 375, height: 750 } },
      async ({ page, result }) => {
        await documentStatus(page, "/catalog", 200, result, "sourceStatus");
        await seriesOnly(page, result);
      },
    ],
    [
      "native-comparison-no-javascript",
      { javaScriptEnabled: false, viewport: { width: 320, height: 750 } },
      async ({ page, result }) => {
        await compareNative(page, result);
      },
    ],
    ...[320, 375].map((width) => [
      `reflow-${width}`,
      { viewport: { width, height: 750 } },
      async ({ page, result }) => {
        result.measurements = {};
        for (const [label, path] of [
          ["home", "/"],
          ["catalog", filtered],
          ["product", product],
          ["series", seriesPath],
          [
            "comparison",
            `/compare?book=khu-vuon-sau-con-mua&with=${compareWith}`,
          ],
          ["cart", "/cart"],
          ["wishlist", "/wishlist"],
        ]) {
          await documentStatus(page, path, 200, result, `${label}Status`);
          await visible(page.getByRole("heading", { level: 1 }));
          const measurement = await reflow(page);
          result.measurements[label] = measurement;
          requireThat(
            measurement.viewportWidth === width &&
              measurement.horizontalOverflow <= 0,
            "horizontal-overflow",
          );
          if (label === "catalog") {
            const form = page.locator(".filter-bar");
            const labels = await form.locator("select").evaluateAll((selects) =>
              selects.map((select) => {
                const computed = getComputedStyle(select);
                const ctx = document.createElement("canvas").getContext("2d");
                ctx.font = `${computed.fontStyle} ${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`;
                const label =
                  select.selectedOptions[0]?.textContent?.trim() ?? "";
                return {
                  label,
                  estimatedLabelWidth: Math.round(ctx.measureText(label).width),
                  contentBoxWidth: Math.round(
                    select.clientWidth -
                      parseFloat(computed.paddingLeft) -
                      parseFloat(computed.paddingRight),
                  ),
                };
              }),
            );
            requireThat(
              labels.length === 2 &&
                labels.every(
                  (entry) =>
                    entry.label &&
                    entry.contentBoxWidth > 0 &&
                    Number.isFinite(entry.estimatedLabelWidth),
                ),
              "native-select-label-missing",
            );
            // Approximation only: browser/desktop native chrome can take more space than CSS content width.
            result.nativeSelect = {
              assessment: "estimated-fit-only; native picker not automated",
              selectedLabels: labels.map(
                ({ label, estimatedLabelWidth, contentBoxWidth }) => ({
                  label,
                  estimatedLabelWidth,
                  contentBoxWidth,
                  possibleClipping: estimatedLabelWidth >= contentBoxWidth,
                }),
              ),
            };
            try {
              const image = await form.screenshot({
                type: "jpeg",
                quality: 20,
                scale: "css",
                animations: "disabled",
                timeout: 2500,
              });
              if (image.length <= 14000)
                result.formScreenshot = {
                  mime: "image/jpeg",
                  bytes: image.length,
                  base64: image.toString("base64"),
                };
              else result.formScreenshotOmitted = "size-cap";
            } catch {
              result.formScreenshotOmitted = "capture-unavailable";
            }
          }
        }
      },
    ]),
    ...["cart", "wishlist"].map((mode) => [
      `demo-${mode}-initialization-and-deletion-focus`,
      { viewport: { width: 375, height: 750 } },
      async ({ page, context, result, setScriptMode, whenScriptHeld }) => {
        const key = "bookstore-demo-v1";
        const ids = [
          "khu-vuon-sau-con-mua",
          "tiem-tra-cuoi-chan-troi",
          "nhung-la-thu-gui-mua-thu",
        ];
        const titles = [
          "Khu vườn sau cơn mưa",
          "Tiệm trà cuối chân trời",
          "Những lá thư gửi mùa thu",
        ];
        const emptyName =
          mode === "cart"
            ? "Giỏ sách còn một khoảng trống"
            : "Cuốn sách yêu thích đầu tiên đang chờ bạn";
        const empty = page.getByRole("heading", {
          name: emptyName,
          exact: true,
        });
        const pending = page
          .getByRole("status")
          .filter({ hasText: pendingText });
        const rows = page.locator(".collection-row");
        await context.addInitScript(
          ({ key, mode, ids }) => {
            if (localStorage.getItem(key) === null)
              localStorage.setItem(
                key,
                JSON.stringify(
                  mode === "cart"
                    ? {
                        wishlist: [],
                        cart: Object.fromEntries(ids.map((id) => [id, 1])),
                      }
                    : { cart: {}, wishlist: ids },
                ),
              );
          },
          { key, mode, ids },
        );
        const releaseScripts = setScriptMode("hold");
        try {
          const response = await page.goto(abs("/" + mode), {
            waitUntil: "commit",
            timeout: stepMs,
          });
          result.initialDocument = response?.status() ?? null;
          requireThat(
            result.initialDocument === 200,
            "demo-initial-document-status",
          );
          await visible(pending);
          await limited(whenScriptHeld(), stepMs, "demo-no-bundle-held");
          requireThat(
            (await empty.count()) === 0 && (await rows.count()) === 0,
            "demo-pending-state-incorrect",
          );
          await page.evaluate((name) => {
            const seen = () =>
              [...document.querySelectorAll("main h2")].some(
                (el) => el.textContent?.trim() === name,
              );
            window.__matrixDemoEmptySeen = seen();
            new MutationObserver((records) => {
              const added = records.flatMap((record) => [...record.addedNodes]);
              if (
                seen() ||
                added.some(
                  (node) =>
                    node.nodeType === 1 &&
                    ((node.matches("h2") &&
                      node.textContent?.trim() === name) ||
                      [...node.querySelectorAll("h2")].some(
                        (el) => el.textContent?.trim() === name,
                      )),
                )
              )
                window.__matrixDemoEmptySeen = true;
            }).observe(document.querySelector("main"), {
              childList: true,
              subtree: true,
              characterData: true,
            });
          }, emptyName);
        } finally {
          releaseScripts();
        }
        await visible(rows.nth(2));
        await absent(pending);
        requireThat(
          exactTexts(
            await rows.getByRole("heading").allTextContents(),
            titles,
          ) &&
            (await page.evaluate(
              () =>
                !window.__matrixDemoEmptySeen &&
                document.activeElement === document.body,
            )),
          "demo-populated-state-or-initial-focus",
        );
        const reload = await page.reload({
          waitUntil: "domcontentloaded",
          timeout: stepMs,
        });
        requireThat(reload?.status() === 200, "demo-reload-document-status");
        await visible(rows.nth(2));
        requireThat(
          exactTexts(
            await rows.getByRole("heading").allTextContents(),
            titles,
          ) &&
            (await page.evaluate(
              () => document.activeElement === document.body,
            )),
          "demo-reload-state-or-initial-focus",
        );
        await visible(
          page.getByText(
            mode === "cart"
              ? /không giữ hàng, không tính tiền và không tạo đơn/
              : /Không đồng bộ tài khoản/,
          ),
        );
        const remove = (index) =>
          rows.getByRole("button", {
            name:
              mode === "cart"
                ? `Xóa ${titles[index]}`
                : `Bỏ yêu thích: ${titles[index]}`,
            exact: true,
          });
        await remove(1).focus();
        await page.keyboard.press("Enter");
        await focused(remove(2), page, "demo-next-row-focus");
        requireThat(
          await remove(2).evaluate(
            (el) => getComputedStyle(el).outlineStyle !== "none",
          ),
          "demo-deletion-focus-outline",
        );
        await visible(
          page
            .locator(".collection-announcement")
            .filter({ hasText: titles[1] }),
        );
        await page.keyboard.press("Enter");
        await focused(remove(0), page, "demo-previous-row-focus");
        await page.keyboard.press("Enter");
        await visible(empty);
        const recover = page
          .locator("main .empty-state")
          .getByRole("link", { name: "Khám phá kệ sách" });
        await focused(recover, page, "demo-empty-recovery-focus");
        requireThat(
          (await recover.getAttribute("href")) === "/catalog" &&
            (await page.evaluate((key) => {
              const state = JSON.parse(localStorage.getItem(key));
              return (
                Array.isArray(state.wishlist) &&
                state.wishlist.length === 0 &&
                Object.keys(state.cart).length === 0
              );
            }, key)),
          "demo-empty-recovery-or-cleared-storage",
        );
        result.focusTransitions = [
          "next-row",
          "previous-row",
          "empty-state-catalog-link",
        ];
        result.openedWithoutFocusMovement = true;
      },
    ]),
    [
      "javascript-disabled-discovery-and-demo-fallback",
      { javaScriptEnabled: false, viewport: { width: 375, height: 750 } },
      async ({ page, result }) => {
        await browseHome(page, result);
        await seriesOnly(page, result);
        const back = page
          .getByRole("navigation", { name: "Đường dẫn", exact: true })
          .getByRole("link", { name: "Kệ sách", exact: true });
        requireThat(
          (await back.getAttribute("href")) === "/catalog",
          "no-script-breadcrumb-destination",
        );
        await Promise.all([at(page, "/catalog"), back.click()]);
        result.scripting = await page.evaluate(() => ({
          none: matchMedia("(scripting: none)").matches,
          enabled: matchMedia("(scripting: enabled)").matches,
        }));
        requireThat(
          !result.scripting.enabled,
          "scripting-media-mismatch-when-disabled",
        );
        result.demoFallback = {};
        for (const mode of ["cart", "wishlist"]) {
          await documentStatus(page, "/" + mode, 200, result, `${mode}Status`);
          const fallback = page.getByText(noScriptText, { exact: true });
          const pending = page.getByText(pendingText, { exact: false });
          if (result.scripting.none) {
            await visible(fallback);
            await hidden(pending);
            const discover = page
              .getByRole("main")
              .getByRole("link", { name: "Khám phá kệ sách", exact: true });
            await Promise.all([at(page, "/catalog"), discover.click()]);
            result.demoFallback[mode] = { fallback: true, linkWorked: true };
          } else {
            result.demoFallback[mode] = {
              fallback: await fallback.isVisible(),
              pending: await pending.isVisible(),
            };
          }
        }
        if (!result.scripting.none)
          result.limitations = [
            "css-scripting-none-unavailable-fallback-not-required-to-render",
          ];
      },
    ],
    [
      "javascript-enabled-application-bundles-blocked",
      { viewport: { width: 375, height: 750 } },
      async ({ page, result, setScriptMode, scriptRequests }) => {
        setScriptMode("abort");
        result.scripting = await page.evaluate(() => ({
          none: matchMedia("(scripting: none)").matches,
          enabled: matchMedia("(scripting: enabled)").matches,
        }));
        requireThat(
          !result.scripting.none,
          "scripting-none-matched-with-javascript-enabled",
        );
        await browseHome(page, result);
        await seriesOnly(page, result);
        result.demoState = {};
        for (const mode of ["cart", "wishlist"]) {
          await documentStatus(
            page,
            "/" + mode,
            200,
            result,
            `${mode}BlockedStatus`,
          );
          await page.waitForLoadState("load", { timeout: stepMs });
          const fallback = await page
            .getByText(noScriptText, { exact: true })
            .isVisible();
          const pending = await page
            .getByText(pendingText, { exact: false })
            .isVisible();
          const collectionRows = await page.locator(".collection-row").count();
          result.demoState[mode] = { fallback, pending, collectionRows };
          requireThat(
            !fallback && pending && collectionRows === 0,
            "blocked-bundle-demo-state-mismatch",
          );
        }
        result.abortedApplicationScripts = scriptRequests().aborted;
        requireThat(
          result.abortedApplicationScripts > 0,
          "application-script-blocking-unproved",
        );
        result.limitations = [
          "demo-initialization-remains-pending-with-application-bundles-blocked",
        ];
      },
    ],
    [
      "configuration-error-recovery-and-same-url-retry",
      { viewport: { width: 320, height: 750 } },
      async ({ page, result }) => {
        if (!failing)
          throw new MatrixFault("owned-failure-origin-unavailable", "blocked");
        const path = "/catalog?q=kiem-tra";
        const response = await documentStatus(
          page,
          path,
          500,
          result,
          "failureDocument",
          failing,
        );
        await visible(getH1(page, recoveryTitle));
        await visible(page.getByRole("main").getByText(brand, { exact: true }));
        await visible(
          page.getByText(
            "Nhà sách đang gặp sự cố khi tải dữ liệu. Bạn có thể thử tải lại trang.",
            { exact: true },
          ),
        );
        requireThat(
          (await page.title()) === `${recoveryTitle} | ${brand}`,
          "recovery-title-mismatch",
        );
        const retry = page.getByRole("link", { name: "Thử lại", exact: true });
        await visible(retry);
        requireThat(
          (await reflow(page)).horizontalOverflow <= 0,
          "recovery-overflow",
        );
        await inspectFailure(response, page);
        await page.keyboard.press("Tab");
        await focused(retry, page, "recovery-tab-focus");
        requireThat(
          await retry.evaluate(
            (el) => getComputedStyle(el).outlineStyle !== "none",
          ),
          "recovery-outline-missing",
        );
        const [retried] = await Promise.all([
          page.waitForResponse(
            (r) =>
              r.url() === abs(path, failing) &&
              r.request().isNavigationRequest() &&
              r.request().resourceType() === "document" &&
              r.request().method() === "GET",
            { timeout: stepMs },
          ),
          page.keyboard.press("Enter"),
        ]);
        result.retryDocument = retried.status();
        requireThat(
          result.retryDocument === 500 && page.url() === abs(path, failing),
          "recovery-retry-not-same-document-500",
        );
        await visible(getH1(page, recoveryTitle));
        await inspectFailure(retried, page);
        result.testedRedaction = true;
        result.fixtureSubstitutionObserved = false;
        result.recoveryScope =
          "persistent invalid configuration, not source restoration";
      },
    ],
    ...[
      ["no-javascript", false],
      ["application-bundles-blocked", true],
    ].map(([mode, js]) => [
      `configuration-error-${mode}`,
      { javaScriptEnabled: js, viewport: { width: 320, height: 750 } },
      async ({ page, result, setScriptMode, scriptRequests }) => {
        if (!failing)
          throw new MatrixFault("owned-failure-origin-unavailable", "blocked");
        if (js) setScriptMode("abort");
        const response = await documentStatus(
          page,
          "/catalog?q=kiem-tra",
          500,
          result,
          "failureDocument",
          failing,
        );
        await page.waitForLoadState("load", { timeout: stepMs });
        await inspectFailure(response, page);
        result.recoveryVisible = await getH1(page, recoveryTitle).isVisible();
        result.retryVisible = await page
          .getByRole("link", { name: "Thử lại", exact: true })
          .isVisible();
        if (js) {
          result.abortedApplicationScripts = scriptRequests().aborted;
          requireThat(
            result.abortedApplicationScripts > 0,
            "failure-bundle-blocking-unproved",
          );
        }
        requireThat(
          !result.recoveryVisible && !result.retryVisible,
          "unexpected-recovery-without-application-bundles",
        );
        result.testedRedaction = true;
        result.limitations = [
          "initial-global-error-recovery-requires-application-javascript",
        ];
      },
    ]),
  ];

  async function isolatedCase(browser, options, run, result) {
    let context;
    let closing = false;
    let scriptMode = "allow";
    let scriptGate;
    let unblock;
    let heldEvent;
    let notifyHeld;
    const counts = { aborted: 0, held: 0 };
    const setScriptMode = (mode) => {
      if (mode === "hold") {
        requireThat(!unblock, "existing-script-gate");
        scriptGate = new Promise((resolve) => {
          unblock = resolve;
        });
        heldEvent = new Promise((resolve) => {
          notifyHeld = resolve;
        });
      }
      scriptMode = mode;
      return () => {
        scriptMode = "allow";
        unblock?.();
        unblock = undefined;
      };
    };
    const runCase = async () => {
      context = await browser.newContext({
        viewport: { width: 1280, height: 860 },
        serviceWorkers: "block",
        reducedMotion: "reduce",
        ...options,
      });
      if (closing) {
        await context.close();
        return;
      }
      await context.route("**/*", async (route) => {
        try {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== healthy && url.origin !== failing)
            return await route.abort();
          if (
            request.resourceType() === "script" &&
            blockedScript.test(url.pathname)
          ) {
            if (scriptMode === "abort") {
              counts.aborted++;
              return await route.abort();
            }
            if (scriptMode === "hold") {
              counts.held++;
              notifyHeld?.();
              await scriptGate;
            }
          }
          if (closing) await route.abort();
          else await route.continue();
        } catch {
          /* Context closes under a deadline; do not record request data or raw errors. */
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(stepMs);
      page.setDefaultNavigationTimeout(stepMs);
      await run({
        page,
        context,
        result,
        setScriptMode,
        whenScriptHeld: () => heldEvent,
        scriptRequests: () => ({ ...counts }),
      });
      if (counts.held > 0) result.heldApplicationScripts = counts.held;
    };
    try {
      await untilShutdown(
        limited(runCase(), deadlineMs, "browser-case-deadline"),
      );
      result.status = "pass";
    } catch (error) {
      Object.assign(result, errorReceipt(error));
    } finally {
      closing = true;
      unblock?.();
      if (context) {
        try {
          await limited(
            context.close(),
            cleanupMs,
            "browser-context-cleanup-timeout",
          );
          result.contextClosed = true;
        } catch {
          result.contextClosed = false;
          result.status = "fail";
          result.cleanupCode = "browser-context-close-unconfirmed";
        }
      }
    }
  }
  async function runEngine(name) {
    const record = (results.engines[name] = {
      status: "blocked",
      version: null,
      cases: {},
    });
    const type = browserTypes?.[name];
    const blockRemaining = (code) => {
      for (const [label] of cases)
        record.cases[label] ??= { status: "blocked", code };
    };
    if (!type || typeof type.launch !== "function") {
      record.code = "engine-not-provided";
      blockRemaining(record.code);
      return;
    }
    let browser;
    let abandoned = false;
    try {
      if (shutdown.signal.aborted) {
        blockRemaining("harness-interrupted");
        return;
      }
      const launched = type.launch({ headless: true, timeout: 12000 });
      void launched.then(
        (late) =>
          abandoned && !browser ? late.close().catch(() => {}) : undefined,
        () => {},
      );
      browser = await limited(
        launched,
        13000,
        "browser-engine-launch-deadline",
      );
      const version = browser.version();
      record.version =
        typeof version === "string" && /^[\w .+()_-]{1,80}$/.test(version)
          ? version
          : null;
      for (const [label, options, run] of cases) {
        if (shutdown.signal.aborted) {
          blockRemaining("harness-interrupted");
          break;
        }
        const result = (record.cases[label] = { status: "blocked" });
        const begin = Date.now();
        await isolatedCase(browser, options, run, result);
        result.elapsedMs = Date.now() - begin;
        if (result.contextClosed === false) {
          blockRemaining("prior-context-cleanup-unconfirmed");
          break;
        }
      }
    } catch {
      record.code = browser
        ? "browser-engine-operation-failed"
        : "browser-engine-launch-unavailable";
      blockRemaining(record.code);
    } finally {
      abandoned = true;
      if (browser) {
        try {
          await limited(browser.close(), cleanupMs, "engine-cleanup-timeout");
          record.browserClosed = true;
        } catch {
          record.browserClosed = false;
        }
      }
      const statuses = Object.values(record.cases).map((item) => item.status);
      record.status =
        record.browserClosed === false || statuses.includes("fail")
          ? "fail"
          : !browser || statuses.includes("blocked")
            ? "blocked"
            : "pass";
    }
  }
  // Keep engine runs sequential to limit the exercise to one owned browser at a time.
  for (const engine of engines) await runEngine(engine);
  const statuses = Object.values(results.engines).map(
    (record) => record.status,
  );
  results.status = statuses.includes("fail")
    ? "fail"
    : statuses.includes("blocked")
      ? "blocked"
      : "pass";
  const allCases = Object.values(results.engines).flatMap((record) =>
    Object.values(record.cases),
  );
  results.counts = {
    pass: allCases.filter((record) => record.status === "pass").length,
    fail: allCases.filter((record) => record.status === "fail").length,
    blocked: allCases.filter((record) => record.status === "blocked").length,
    documentedLimitations: allCases.reduce(
      (total, record) => total + (record.limitations?.length ?? 0),
      0,
    ),
  };
  return results;
}

await main();
