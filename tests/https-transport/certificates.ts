import { spawn } from "node:child_process";
import {
  randomBytes,
  randomUUID,
  X509Certificate,
  createPrivateKey,
} from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  realpath,
  lstat,
  chmod,
  rm,
} from "node:fs/promises";
import path from "node:path";

export const TRANSPORT_HOST = "bookstore-transport.invalid";
export const ALIAS_HOST = "other.bookstore-transport.invalid";
export interface TransportCertificates {
  readonly runDirectory: string;
  readonly caPath: string;
  readonly ca: string;
  readonly cert: string;
  readonly key: string;
}
export interface CertificatePeer {
  readonly cert: string;
  readonly key: string;
}
export interface TransportCertificateFixture extends TransportCertificates {
  readonly faults: Readonly<
    Record<"wrongSan" | "expired" | "future", CertificatePeer>
  >;
  close(): Promise<void>;
}
const failure = () =>
  new Error("Owned HTTPS certificate fixture unavailable; details suppressed.");
const ownedFixtures = new Map<string, string>();

/** Never inherit TLS/proxy/Node options, credentials or PostgreSQL settings. */
function toolEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const name of [
    "PATH",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ])
    if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}
function command(
  program: string,
  args: string[],
  capture = false,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      env: toolEnvironment(),
      windowsHide: true,
      stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"],
    });
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.length > 32768) child.kill();
    });
    const timer = setTimeout(() => child.kill(), 60000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(failure());
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && output.length <= 32768) resolve(output.trim());
      else reject(failure());
    });
  });
}
async function privateDirectory(directory: string): Promise<void> {
  if (process.platform !== "win32") {
    await chmod(directory, 0o700);
    if (((await lstat(directory)).mode & 0o777) !== 0o700) throw failure();
    return;
  }
  const sid = await command(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    ],
    true,
  );
  if (!/^S-1-5-21-(?:\d+-){3}\d+$/.test(sid)) throw failure();
  await command("icacls.exe", [
    directory,
    "/inheritance:r",
    "/grant:r",
    `*${sid}:(OI)(CI)F`,
    "*S-1-5-18:(OI)(CI)F",
    "*S-1-5-32-544:(OI)(CI)F",
  ]);
  // Verify the DACL, not just the icacls exit status. Only this resolved run directory is touched.
  const literal = directory.replace(/'/g, "''");
  const result = await command(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$a=Get-Acl -LiteralPath '${literal}'; $r=@($a.Access | ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; type=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights} }); @{protected=$a.AreAccessRulesProtected; owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; rules=$r} | ConvertTo-Json -Depth 4 -Compress`,
    ],
    true,
  );
  const acl = JSON.parse(result) as {
    protected: boolean;
    owner: string;
    rules: Array<{
      sid: string;
      inherited: boolean;
      type: string;
      rights: number;
    }>;
  };
  const allowed = new Set([sid, "S-1-5-18", "S-1-5-32-544"]);
  if (
    !acl.protected ||
    !allowed.has(acl.owner) ||
    acl.rules.length !== 3 ||
    acl.rules.some(
      (r) =>
        !allowed.has(r.sid) ||
        r.inherited ||
        r.type !== "Allow" ||
        r.rights !== 2032127,
    ) ||
    new Set(acl.rules.map((r) => r.sid)).size !== 3
  )
    throw failure();
  await command("icacls.exe", [directory, "/verify"]);
}
async function privateFile(file: string, content: string): Promise<void> {
  await writeFile(file, content, { flag: "wx", mode: 0o600 });
}
async function verifyPrivateKeys(directory: string): Promise<void> {
  const names = [
    "root.key",
    "leaf.key",
    "wrongSan.key",
    "expired.key",
    "future.key",
  ];
  if (process.platform !== "win32") {
    for (const name of names) {
      if (((await lstat(path.join(directory, name))).mode & 0o777) !== 0o600)
        throw failure();
    }
    return;
  }
  const literal = directory.replace(/'/g, "''");
  const verified = await command(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ErrorActionPreference='Stop'; $d='${literal}'; $allowed=@((Get-Acl -LiteralPath $d).Access | ForEach-Object { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value }); foreach($n in @('root.key','leaf.key','wrongSan.key','expired.key','future.key')) { $a=Get-Acl -LiteralPath (Join-Path $d $n); if($a.Access.Count -ne 3) { exit 1 }; foreach($r in $a.Access) { $s=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($allowed -notcontains $s -or $r.AccessControlType.ToString() -ne 'Allow' -or [int]$r.FileSystemRights -ne 2032127) { exit 1 } } }; 'verified'`,
    ],
    true,
  );
  if (verified !== "verified") throw failure();
}
export function validateTransportCertificate(
  fixture: TransportCertificates,
): boolean {
  try {
    const ca = new X509Certificate(fixture.ca),
      leaf = new X509Certificate(fixture.cert);
    const now = Date.now();
    return (
      ca.ca &&
      ca.verify(ca.publicKey) &&
      !leaf.ca &&
      leaf.checkIssued(ca) &&
      leaf.verify(ca.publicKey) &&
      leaf.checkPrivateKey(createPrivateKey(fixture.key)) &&
      [ca, leaf].every(
        (c) => Date.parse(c.validFrom) <= now && now < Date.parse(c.validTo),
      ) &&
      leaf.checkHost(TRANSPORT_HOST, { wildcards: false, subject: "never" }) ===
        TRANSPORT_HOST &&
      leaf.checkIP("127.0.0.1") === "127.0.0.1" &&
      leaf.keyUsage?.includes("1.3.6.1.5.5.7.3.1") === true
    );
  } catch {
    return false;
  }
}

export async function createTransportCertificates(): Promise<TransportCertificateFixture> {
  const intendedParent = path.resolve(".local");
  await mkdir(intendedParent, { recursive: true });
  if (
    (await lstat(intendedParent)).isSymbolicLink() ||
    (await realpath(intendedParent)) !== intendedParent
  )
    throw failure();
  const directory = path.join(
    intendedParent,
    `https-transport-${randomUUID()}`,
  );
  await mkdir(directory, { mode: 0o700 });
  const marker = randomBytes(32).toString("hex");
  let marked = false;
  async function close(): Promise<void> {
    // Resolve and verify the exact absolute target AND marker before any deletion.
    if (
      path.dirname(directory) !== intendedParent ||
      !/^https-transport-[a-f0-9-]{36}$/.test(path.basename(directory)) ||
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory ||
      !marked ||
      (await readFile(path.join(directory, "ownership"), "utf8")) !== marker
    )
      throw failure();
    await rm(directory, { recursive: true, force: false });
    ownedFixtures.delete(directory);
    marked = false;
  }
  try {
    await privateDirectory(directory);
    await privateFile(path.join(directory, "ownership"), marker);
    marked = true;
    ownedFixtures.set(directory, marker);
    const p = (name: string) => path.join(directory, name);
    const opensslPath =
      process.platform === "win32"
        ? "C:\\msys64\\ucrt64\\bin\\openssl.exe"
        : "openssl";
    const openssl = (args: string[]) => command(opensslPath, args);
    await openssl(["version"]);
    await privateFile(
      p("root.cnf"),
      "[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=root\n[dn]\nCN=Disposable BookStore Test CA\n[root]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
    );
    await openssl([
      "req",
      "-new",
      "-x509",
      "-newkey",
      "rsa:3072",
      "-noenc",
      "-sha256",
      "-days",
      "1",
      "-config",
      p("root.cnf"),
      "-keyout",
      p("root.key"),
      "-out",
      p("root.pem"),
    ]);
    await mkdir(p("issued"), { mode: 0o700 });
    await privateFile(p("index"), "");
    await privateFile(p("serial"), `01${randomBytes(15).toString("hex")}\n`);
    const configPath = (value: string) => value.replace(/\\/g, "/");
    const dbConfig = `[ca]\ndefault_ca=issuer\n[issuer]\ndatabase=${configPath(p("index"))}\nnew_certs_dir=${configPath(p("issued"))}\nserial=${configPath(p("serial"))}\ncertificate=${configPath(p("root.pem"))}\nprivate_key=${configPath(p("root.key"))}\ndefault_md=sha256\ndefault_days=1\npolicy=policy\nunique_subject=no\n[policy]\ncommonName=supplied\n`;
    const faults = {} as Record<
      "wrongSan" | "expired" | "future",
      CertificatePeer
    >;
    let leaf: CertificatePeer | undefined;
    for (const name of ["leaf", "wrongSan", "expired", "future"] as const) {
      const san =
        name === "wrongSan"
          ? "DNS:wrong-bookstore.invalid"
          : `DNS:${TRANSPORT_HOST},DNS:${ALIAS_HOST},IP:127.0.0.1`;
      await privateFile(
        p(`${name}.cnf`),
        `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=Disposable BookStore ${name}\n`,
      );
      await privateFile(
        p(`${name}-ca.cnf`),
        `${dbConfig}\n[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${san}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n`,
      );
      await openssl([
        "req",
        "-new",
        "-newkey",
        "rsa:3072",
        "-noenc",
        "-sha256",
        "-config",
        p(`${name}.cnf`),
        "-keyout",
        p(`${name}.key`),
        "-out",
        p(`${name}.csr`),
      ]);
      const dates =
        name === "expired"
          ? ["-startdate", "20000101000000Z", "-enddate", "20000102000000Z"]
          : name === "future"
            ? ["-startdate", "20990101000000Z", "-enddate", "20990102000000Z"]
            : [];
      await openssl([
        "ca",
        "-batch",
        "-notext",
        "-config",
        p(`${name}-ca.cnf`),
        "-extensions",
        "leaf",
        ...dates,
        "-in",
        p(`${name}.csr`),
        "-out",
        p(`${name}.pem`),
      ]);
      if (process.platform !== "win32") await chmod(p(`${name}.key`), 0o600);
      const peer = Object.freeze({
        cert: await readFile(p(`${name}.pem`), "utf8"),
        key: await readFile(p(`${name}.key`), "utf8"),
      });
      if (name === "leaf") leaf = peer;
      else faults[name] = peer;
    }
    if (process.platform !== "win32") await chmod(p("root.key"), 0o600);
    if (!leaf) throw failure();
    await verifyPrivateKeys(directory);
    const fixture = Object.freeze({
      runDirectory: directory,
      caPath: p("root.pem"),
      ca: await readFile(p("root.pem"), "utf8"),
      ...leaf,
      faults: Object.freeze(faults),
      close,
    });
    if (!validateTransportCertificate(fixture)) throw failure();
    await openssl([
      "verify",
      "-CAfile",
      fixture.caPath,
      "-purpose",
      "sslserver",
      "-verify_hostname",
      TRANSPORT_HOST,
      p("leaf.pem"),
    ]);
    await openssl([
      "verify",
      "-CAfile",
      fixture.caPath,
      "-purpose",
      "sslserver",
      "-verify_ip",
      "127.0.0.1",
      p("leaf.pem"),
    ]);
    return fixture;
  } catch {
    if (marked) await close();
    throw failure();
  }
}

export async function prepareLinuxBrowserTrust(
  fixture: TransportCertificates,
  trusted: boolean,
): Promise<{ home: string; userDataDir: string; env: NodeJS.ProcessEnv }> {
  if (process.platform !== "linux")
    throw new Error(
      "Linux NSS browser trust is required; this command does not support this OS.",
    );
  try {
    const directory = path.resolve(fixture.runDirectory);
    if (
      directory !== fixture.runDirectory ||
      (await lstat(directory)).isSymbolicLink() ||
      (await realpath(directory)) !== directory ||
      path.dirname(directory) !== path.resolve(".local") ||
      !/^https-transport-[a-f0-9-]{36}$/.test(path.basename(directory)) ||
      !ownedFixtures.has(directory) ||
      (await readFile(path.join(directory, "ownership"), "utf8")) !==
        ownedFixtures.get(directory) ||
      fixture.caPath !== path.join(directory, "root.pem") ||
      (await readFile(fixture.caPath, "utf8")) !== fixture.ca
    )
      throw failure();
    const home = path.join(directory, `browser-${randomUUID()}`);
    const database = path.join(home, ".local", "share", "pki", "nssdb");
    await mkdir(database, { recursive: true, mode: 0o700 });
    const userDataDir = path.join(home, "chromium-profile");
    await mkdir(userDataDir, { mode: 0o700 });
    await command("certutil", [
      "-N",
      "-d",
      `sql:${database}`,
      "--empty-password",
    ]);
    if (trusted)
      await command("certutil", [
        "-A",
        "-d",
        `sql:${database}`,
        "-t",
        "C,,",
        "-n",
        "Disposable BookStore Test CA",
        "-i",
        fixture.caPath,
      ]);
    const env: NodeJS.ProcessEnv = {
      ...toolEnvironment(),
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      XDG_CACHE_HOME: path.join(home, ".cache"),
      NODE_ENV: "test",
    };
    return { home, userDataDir, env };
  } catch {
    throw failure();
  }
}
