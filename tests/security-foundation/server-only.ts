// Node-only integration alias for Next's build-time marker, never a production alias.
if (typeof window !== "undefined")
  throw new Error("Server-only security module cannot run in a browser.");
export {};
