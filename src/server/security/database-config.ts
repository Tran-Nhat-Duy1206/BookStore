/** Independent foundation guard: no catalog/spike URL or environment fallback. */
export type FoundationPurpose =
  "migrate" | "reader" | "auth" | "staff" | "worker";

const purposes: readonly FoundationPurpose[] = [
  "migrate",
  "reader",
  "auth",
  "staff",
  "worker",
];

function parse(value: string): URL {
  try {
    // Reject raw normalization tricks, encoded identifiers and empty ?/# too.
    if (typeof value !== "string" || !value || /\s|[?#]/.test(value))
      throw new Error();
    const url = new URL(value);
    const password = decodeURIComponent(url.password);
    if (
      !/^(postgres|postgresql):\/\/[^/@]+@(?:127\.0\.0\.1|localhost|\[::1\]):(?:55436|55437)\/[a-z0-9_]+$/.test(
        value,
      ) ||
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !["55436", "55437"].includes(url.port) ||
      !password ||
      /\s/.test(password) ||
      [...password].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new Error(
      "Invalid isolated BookStore security-foundation database URL.",
    );
  }
}

/** Exact local/CI bootstrap identity; returns the original validated URL. */
export function assertFoundationBaseUrl(value: string): string {
  const url = parse(value);
  if (
    url.username !== "bookstore_security_bootstrap" ||
    !(
      (url.port === "55436" && url.pathname === "/bookstore_security_test") ||
      (url.port === "55437" && url.pathname === "/bookstore_security_ci")
    )
  )
    throw new Error(
      "Foundation administration requires the exact bootstrap user and local/CI base database/port.",
    );
  return value;
}

/** Exact LOGIN purpose and identical 12-hex disposable role/database suffix. */
export function assertFoundationUrl(
  value: string,
  purpose: FoundationPurpose,
): string {
  const url = parse(value);
  const suffix = /^\/bookstore_security_test_([a-f0-9]{12})$/.exec(
    url.pathname,
  )?.[1];
  if (
    !purposes.includes(purpose) ||
    !suffix ||
    url.username !== `bf_${suffix}_${purpose}`
  ) {
    throw new Error(
      "Foundation URL role, purpose and disposable database must match exactly.",
    );
  }
  return value;
}
