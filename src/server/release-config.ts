export const releaseHost = "127.0.0.1";
const databaseSettings = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "BOOKSTORE_LOCAL_DB_READS",
] as const;

// Browser-restricted ports accepted by the lexical range but refused by Next 16.4.5.
const reservedPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667,
  6668, 6669, 6697, 10080,
]);

export type ReleaseEnvironment = Readonly<Record<string, string | undefined>>;
type ReleaseConfig = { port: number; env: NodeJS.ProcessEnv };
type ReleaseResult =
  { ok: true; config: ReleaseConfig } | { ok: false; message: string };

export function evaluateReleaseConfig(
  args: readonly string[],
  inherited: ReleaseEnvironment,
): ReleaseResult {
  const reject = (message: string): ReleaseResult => ({ ok: false, message });
  const [intent, portArg] = args;
  if (intent === "staging-real" || intent === "production-real") {
    return reject(
      "Real-content staging and production releases are not authorized.",
    );
  }
  if (intent !== "staging-demo") {
    return reject("Supply the exact positional release intent staging-demo.");
  }
  if (
    args.length > 2 ||
    (portArg !== undefined && !portArg.startsWith("--port="))
  ) {
    return reject("Only the optional --port=<number> argument is supported.");
  }
  const match =
    portArg === undefined ? null : /^--port=([1-9][0-9]{3,4})$/.exec(portArg);
  const port = portArg === undefined ? 3001 : Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 3000) {
    return reject("Choose a decimal port from 1024 to 65535, excluding 3000.");
  }
  if (reservedPorts.has(port))
    return reject("Choose a port that is not reserved by Next.js.");
  const entries = Object.entries(inherited);
  if (
    inherited.DATA_SOURCE !== "fixture" ||
    entries.some(
      ([key]) => key !== "DATA_SOURCE" && key.toUpperCase() === "DATA_SOURCE",
    )
  ) {
    return reject(
      "Set inherited DATA_SOURCE explicitly to fixture for staging-demo.",
    );
  }
  for (const setting of databaseSettings) {
    if (
      entries.some(
        ([key, value]) =>
          key.toUpperCase() === setting && value !== undefined && value !== "",
      )
    ) {
      return reject(`${setting} must be absent or empty for staging-demo.`);
    }
  }
  const controlled = new Set<string>([
    "DATA_SOURCE",
    ...databaseSettings,
    "NODE_ENV",
    "NODE_OPTIONS",
    "NODE_PATH",
    "PORT",
    "HOSTNAME",
  ]);
  const env = Object.fromEntries(
    entries.filter(
      ([key]) =>
        !controlled.has(key.toUpperCase()) &&
        !key.toUpperCase().startsWith("__NEXT_PRIVATE_"),
    ),
  );
  return {
    ok: true,
    config: {
      port,
      env: {
        ...env,
        DATA_SOURCE: "fixture",
        DATABASE_URL: "",
        TEST_DATABASE_URL: "",
        BOOKSTORE_LOCAL_DB_READS: "",
        NODE_ENV: "production",
      },
    },
  };
}
