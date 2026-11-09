import { beforeAll, describe, expect, it } from "vitest";
import { ESLint, type Linter } from "eslint";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../", import.meta.url));
const localRequire = createRequire(import.meta.url);
const nextRequire = createRequire(localRequire.resolve("eslint-config-next"));
const tsRequire = createRequire(nextRequire.resolve("typescript-eslint"));
const estreeRequire = createRequire(
  tsRequire.resolve("@typescript-eslint/typescript-estree"),
);
const matcher = estreeRequire("minimatch") as {
  minimatch(
    path: string,
    pattern: string,
    options: { dot: boolean; platform?: "win32" | "linux" },
  ): boolean;
};
const typescript = nextRequire("typescript-eslint") as {
  parser: NonNullable<Linter.LanguageOptions["parser"]>;
};
let configured: ESLint;
beforeAll(() => {
  configured = new ESLint({ cwd: root });
});

async function lint(code: string, name = "probe.tsx", eslint = configured) {
  const result = await eslint.lintText(code, {
    filePath: resolve(root, "src", name),
  });
  expect(result).toHaveLength(1);
  expect(result[0].messages.some((message) => message.fatal)).toBe(false);
  return result[0];
}

describe("existing ESLint9/Next16 plugin contract", () => {
  it("accepts a valid existing-stack component", async () => {
    const result = await lint(
      'import Link from "next/link"; export default function Probe() { return <Link href="/catalog">Synthetic link</Link>; }',
    );
    expect(result.errorCount).toBe(0);
    expect(result.warningCount).toBe(0);
  }, 30000);
  it.each([
    [
      "@typescript-eslint/no-explicit-any",
      "export function probe(value: any) { return value; }",
      "probe.ts",
    ],
    [
      "@typescript-eslint/no-unused-vars",
      "const unused = 1; export {};",
      "probe.ts",
    ],
    [
      "react/jsx-key",
      "export default function Probe() { return [<span />, <span />]; }",
      "probe.tsx",
    ],
    [
      "react-hooks/rules-of-hooks",
      'import { useEffect } from "react"; export default function Probe({ active }: { active: boolean }) { if (active) useEffect(() => {}, []); return null; }',
      "probe.tsx",
    ],
    [
      "jsx-a11y/alt-text",
      'export default function Probe() { return <img src="/synthetic.png" />; }',
      "probe.tsx",
    ],
    [
      "@next/next/no-sync-scripts",
      'export default function Probe() { return <script src="/synthetic.js" />; }',
      "probe.tsx",
    ],
    [
      "import/no-anonymous-default-export",
      "export default { synthetic: true };",
      "probe.ts",
    ],
  ])("still reports enabled %s", async (ruleId, code, filename) => {
    const result = await lint(code, filename);
    expect(
      result.messages.some(
        (message) => message.ruleId === ruleId && message.severity > 0,
      ),
    ).toBe(true);
  });
});

describe("typescript-estree's narrow minimatch consumer", () => {
  it("loads the exact corrected edge without replacing other plugin consumers", () => {
    expect(
      (estreeRequire("minimatch/package.json") as { version: string }).version,
    ).toBe("11.0.1");
    const reactRequire = createRequire(
      nextRequire.resolve("eslint-plugin-react"),
    );
    expect(
      (reactRequire("minimatch/package.json") as { version: string }).version,
    ).toBe("3.1.5");
  });
  it.each([
    ["probe.ts", "*.ts", true],
    [".probe.ts", "*.ts", true],
    ["probe.tsx", "*.{ts,tsx}", true],
    ["nested/probe.ts", "*.ts", false],
    ["nested/probe.ts", "nested/*.ts", true],
    ["probe.js", "*.ts", false],
    ["probe.ts", "!*.js", true],
    ["nested/.probe.ts", "nested/*.ts", true],
  ] as const)(
    "preserves the consumer's dot:true result for %s / %s",
    (file, pattern, expected) => {
      for (const platform of ["win32", "linux"] as const)
        expect(matcher.minimatch(file, pattern, { dot: true, platform })).toBe(
          expected,
        );
    },
  );
  it("preserves native Windows and Linux relative-path matching", () => {
    expect(
      matcher.minimatch("tools\\.config.mjs", "tools/*.mjs", {
        dot: true,
        platform: "win32",
      }),
    ).toBe(true);
    expect(
      matcher.minimatch("tools/.config.mjs", "tools/*.mjs", {
        dot: true,
        platform: "linux",
      }),
    ).toBe(true);
  });
  it("exercises real typed projectService default-project matching and rules", async () => {
    // .mjs is outside the root tsconfig's explicit TS/TSX includes. Virtual
    // files avoid adding ignored invalid-code fixtures or changing app config.
    const typed = new ESLint({
      cwd: root,
      overrideConfig: {
        files: ["**/*.mjs"],
        languageOptions: {
          parser: typescript.parser,
          parserOptions: {
            tsconfigRootDir: root,
            projectService: {
              allowDefaultProject: ["lint-compat-*.mjs"],
              defaultProject: "tsconfig.json",
            },
          },
        },
        rules: { "@typescript-eslint/no-unsafe-call": "error" },
      },
    });
    const [valid] = await typed.lintText(
      "const callback = () => 1; export function probe() { return callback(); }",
      { filePath: resolve(root, "lint-compat-valid.mjs") },
    );
    expect(valid.messages.some((message) => message.fatal)).toBe(false);
    expect(valid.errorCount).toBe(0);
    const [invalid] = await typed.lintText(
      "export function probe(candidate) { return candidate(); }",
      { filePath: resolve(root, "lint-compat-invalid.mjs") },
    );
    expect(invalid.messages.some((message) => message.fatal)).toBe(false);
    expect(
      invalid.messages.some(
        (message) =>
          message.ruleId === "@typescript-eslint/no-unsafe-call" &&
          message.severity === 2,
      ),
    ).toBe(true);
    const [unmatched] = await typed.lintText("export const value = 1;", {
      filePath: resolve(root, "not-allowed-by-default-project.mjs"),
    });
    expect(
      unmatched.messages.some(
        (message) =>
          message.fatal && message.message.includes("project service"),
      ),
    ).toBe(true);
  }, 30000);
});
