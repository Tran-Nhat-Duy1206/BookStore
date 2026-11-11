import {
  startRestrictedHttpsTestTransport,
  type RestrictedHttpsTestTransportConfig,
} from "../../src/server/security/https-transport";

async function main(): Promise<void> {
  const encoded = process.env.BOOKSTORE_HTTPS_WORKER;
  delete process.env.BOOKSTORE_HTTPS_WORKER;
  if (
    !encoded ||
    encoded.length > 131072 ||
    process.env.NODE_ENV !== "test" ||
    process.env.BOOKSTORE_RESTRICTED_HTTPS_TEST !== "1"
  )
    throw new Error("Unavailable");
  const config = JSON.parse(encoded) as RestrictedHttpsTestTransportConfig;
  const transport = await startRestrictedHttpsTestTransport(config);
  process.stdout.write("HTTPS_READY\n");
  process.on("message", (message) => {
    if (message !== "CLOSE") return;
    void transport.close().then(
      () => {
        process.disconnect?.();
        process.exitCode = 0;
      },
      () => {
        process.disconnect?.();
        process.exitCode = 1;
      },
    );
  });
}
void main().catch(() => {
  process.exitCode = 1;
  process.disconnect?.();
});
