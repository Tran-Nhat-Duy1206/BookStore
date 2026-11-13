import "server-only";

/** Next mutable cookies serialize Set-Cookie attributes in toString(). Project
 * only the awaited native API's name/value pairs back to request-cookie grammar.
 * This is NOT evidence: the service independently matches the original raw jar
 * and uses only the canonical SDK+SQL authority. Never mutate or replace it.
 */
export function nextCookieHeader(store: {
  getAll(): readonly { name: string; value: string }[];
}): string {
  const entries = store.getAll();
  if (entries.length > 5)
    throw new Error("Isolated Next cookie projection denied.");
  return entries
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}
