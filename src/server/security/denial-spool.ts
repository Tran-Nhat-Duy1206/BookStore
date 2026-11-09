import "server-only";

import { constants, type Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type DenialReason =
  "unauthenticated" | "forbidden" | "stale" | "unavailable";
export type DenialOutcome = "denied" | "rolled_back" | "unavailable";
export type DenialRecord = Readonly<{
  requestId: string;
  occurredAt: string;
  reason: DenialReason;
  outcome: DenialOutcome;
}>;
export interface DenialFallback {
  append(record: DenialRecord): Promise<boolean>;
}

const MAX_BYTES = 1_048_576;
const PROJECT = fileURLToPath(new URL("../../../", import.meta.url));
const PARENT = join(PROJECT, ".local");
const ROOT = join(PARENT, "security-foundation-denials");
const MARKER = join(ROOT, ".owner");
const JOURNAL = join(ROOT, "denials.jsonl");
const LOCK = join(ROOT, "known.lock");
const OWNER = "bookstore-security-foundation-denials:v1\n";
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

/** Reject unknown properties/accessors instead of serializing arbitrary input.
 * Only this newly built envelope may be passed to a sink; no actor/provider data.
 */
export function normalizeDenialRecord(value: unknown): DenialRecord | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return null;
    const keys = Reflect.ownKeys(value);
    const fields = ["requestId", "occurredAt", "reason", "outcome"];
    if (
      keys.length !== fields.length ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      fields.some((key) => !descriptors[key] || !("value" in descriptors[key]))
    )
      return null;
    const requestId: unknown = descriptors.requestId?.value;
    const occurredAt: unknown = descriptors.occurredAt?.value;
    const reason: unknown = descriptors.reason?.value;
    const outcome: unknown = descriptors.outcome?.value;
    if (
      typeof requestId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId,
      )
    )
      return null;
    if (
      typeof occurredAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(occurredAt) ||
      new Date(occurredAt).toISOString() !== occurredAt
    )
      return null;
    if (
      reason !== "unauthenticated" &&
      reason !== "forbidden" &&
      reason !== "stale" &&
      reason !== "unavailable"
    )
      return null;
    if (
      outcome !== "denied" &&
      outcome !== "rolled_back" &&
      outcome !== "unavailable"
    )
      return null;
    return Object.freeze({ requestId, occurredAt, reason, outcome });
  } catch {
    return null;
  }
}

export function isValidDenialJournal(value: unknown): boolean {
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_BYTES)
    return false;
  if (value && !value.endsWith("\n")) return false;
  try {
    return value
      .split("\n")
      .filter(Boolean)
      .every((entry) => normalizeDenialRecord(JSON.parse(entry)) !== null);
  } catch {
    return false;
  }
}

async function physicalDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    !samePath(await realpath(path), path)
  ) {
    throw new Error("Unavailable");
  }
  if (
    samePath(path, ROOT) &&
    process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()))
  ) {
    throw new Error("Unavailable");
  }
}

async function regularFile(path: string): Promise<Stats> {
  const info = await lstat(path);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    !samePath(await realpath(path), path)
  ) {
    throw new Error("Unavailable");
  }
  if (
    process.platform !== "win32" &&
    ((info.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && info.uid !== process.getuid()))
  ) {
    throw new Error("Unavailable");
  }
  return info;
}

function sameFile(
  left: { ino: number; dev: number },
  right: { ino: number; dev: number },
): boolean {
  return left.ino === right.ino && left.dev === right.dev;
}

async function checkedHandle(path: string, flags: number): Promise<FileHandle> {
  const before = await regularFile(path);
  const handle = await open(path, flags | NO_FOLLOW);
  try {
    const actual = await handle.stat();
    const after = await regularFile(path);
    if (
      !actual.isFile() ||
      actual.nlink !== 1 ||
      !sameFile(before, actual) ||
      !sameFile(after, actual)
    ) {
      throw new Error("Unavailable");
    }
    return handle;
  } catch {
    await handle.close();
    throw new Error("Unavailable");
  }
}

async function syncDirectory(path: string): Promise<void> {
  // Node/Windows cannot portably fsync directory handles. File fsync is required
  // on every platform; Windows ACLs/directory durability need operator review.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function validateRoot(): Promise<void> {
  await physicalDirectory(PROJECT);
  await physicalDirectory(PARENT);
  await physicalDirectory(ROOT);
  const marker = await checkedHandle(MARKER, constants.O_RDWR);
  try {
    if (
      (await marker.stat()).size !== Buffer.byteLength(OWNER) ||
      (await marker.readFile("utf8")) !== OWNER
    ) {
      throw new Error("Unavailable");
    }
    // An initializer can pause after writing the marker but before its fsync.
    // Every appender persists the validated marker too; directory fsync alone
    // does not establish file-content durability.
    await marker.sync();
  } finally {
    await marker.close();
  }
}

async function prepareRoot(): Promise<void> {
  await physicalDirectory(PROJECT);
  try {
    await mkdir(PARENT, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await physicalDirectory(PARENT);
  // Persist the .local entry in its containing project directory as well as
  // the spool's own entries. Existing parents may have been just created.
  await syncDirectory(PROJECT);
  let created = false;
  try {
    await mkdir(ROOT, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await physicalDirectory(ROOT);
  if (created) {
    // Only the creator may mark a new directory. An existing unmarked root is
    // never adopted/overwritten, even after a previous interrupted initialization.
    const marker = await open(
      MARKER,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    try {
      await marker.writeFile(OWNER, "utf8");
      await marker.sync();
    } finally {
      await marker.close();
    }
  }
  await validateRoot();
  // Another initializer can have written the marker but not yet persisted its
  // parent entry. Every appender must establish the entire directory chain.
  await syncDirectory(ROOT);
  await syncDirectory(PARENT);
}

/** Opt-in bounded local outage evidence, not an authentication mechanism.
 * Fixed project-owned root; no env/path override, rotation, overwrite or deletion
 * of journal data. A stale lock intentionally fails closed; operator intervention
 * is required. Files use 0600/directories 0700; Windows ACL enforcement is only
 * best effort and must be reviewed before operational use. This protects against
 * accidental path/link reuse, not a malicious process with the same OS identity.
 * Construction performs no IO; append returns true only after file fsync.
 */
export function createDurableDenialSpool(
  options: { maxBytes?: number } = {},
): DenialFallback {
  const maxBytes = options.maxBytes ?? MAX_BYTES;
  const validCap =
    Number.isSafeInteger(maxBytes) && maxBytes > 0 && maxBytes <= MAX_BYTES;
  return Object.freeze({
    async append(value: DenialRecord): Promise<boolean> {
      const record = normalizeDenialRecord(value);
      if (!validCap || !record) return false;
      const line = Buffer.from(JSON.stringify(record) + "\n", "utf8");
      if (line.length > maxBytes) return false;
      let lock: FileHandle | undefined;
      let journal: FileHandle | undefined;
      let success = false;
      try {
        await prepareRoot();
        // Exactly one nonblocking acquisition: no busy wait or unbounded queue.
        lock = await open(
          LOCK,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
          0o600,
        );
        await validateRoot();
        const lockInfo = await regularFile(LOCK);
        if (!sameFile(lockInfo, await lock.stat()))
          throw new Error("Unavailable");
        try {
          journal = await open(
            JOURNAL,
            constants.O_RDWR |
              constants.O_APPEND |
              constants.O_CREAT |
              constants.O_EXCL |
              NO_FOLLOW,
            0o600,
          );
          await syncDirectory(ROOT);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          journal = await checkedHandle(
            JOURNAL,
            constants.O_RDWR | constants.O_APPEND,
          );
        }
        const fileInfo = await regularFile(JOURNAL);
        const openedInfo = await journal.stat();
        if (
          !sameFile(fileInfo, openedInfo) ||
          !openedInfo.isFile() ||
          openedInfo.nlink !== 1 ||
          openedInfo.size + line.length > maxBytes
        ) {
          throw new Error("Unavailable");
        }
        // A failed append may leave a partial final record. Never blend a new
        // record into corrupt evidence or silently repair/truncate the journal.
        const existing = await journal.readFile({ encoding: "utf8" });
        if (!isValidDenialJournal(existing)) throw new Error("Unavailable");
        await journal.writeFile(line);
        await journal.sync();
        success = true;
      } catch {
        success = false;
      } finally {
        try {
          await journal?.close();
        } catch {
          success = false;
        }
        if (lock) {
          try {
            // The only unlink is this exact fixed, physically validated owned
            // lock, and only if it still names our exclusively opened file.
            if (!samePath(dirname(LOCK), ROOT)) throw new Error("Unavailable");
            await validateRoot();
            const info = await regularFile(LOCK);
            if (!sameFile(info, await lock.stat()))
              throw new Error("Unavailable");
            await lock.close();
            lock = undefined;
            await unlink(LOCK);
            await syncDirectory(ROOT);
          } catch {
            success = false;
          } finally {
            try {
              await lock?.close();
            } catch {
              success = false;
            }
          }
        }
      }
      return success;
    },
  });
}
