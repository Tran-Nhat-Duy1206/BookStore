# PR #3 — minimatch dependency-audit remediation

## Scope and reproduced baseline

Owner-authorized audit investigation/remediation only, on existing `feat/phase3-b2a-auth-spike`; reviewed HEAD `48225fbee18a796accf12228dc2f2c3e837bd059`. No Batch3.2B, operational authentication, routes, CRUD, commerce, deployment or merge. Historical spike findings/artifacts are retained rather than overwritten.

Reproduced `pnpm audit --json` exit1: one moderate GHSA-g3hv-75wg-m249 / CVE-2026-118764, minimatch10.2.6, development lint tooling; no high/critical. `pnpm why minimatch --depth 20` and the lockfile identify two active versions:3.1.5 for existing ESLint/React/import/a11y consumers, and10.2.6 only beneath typescript-estree8.72.1. Stale directories in the pnpm store are not additional active dependency paths.

### Every reported vulnerable path

All paths start at the root's devDependency eslint-config-next16.4.5 and end at **@typescript-eslint/typescript-estree8.72.1 → minimatch10.2.6**. The full audit reports eleven paths to the same affected installation, not eleven different vulnerabilities:

1. eslint-import-resolver-typescript → eslint-plugin-import → eslint-module-utils → @typescript-eslint/parser → typescript-estree.
2. eslint-import-resolver-typescript → eslint-plugin-import → @typescript-eslint/parser → typescript-estree.
3. eslint-plugin-import → eslint-module-utils → @typescript-eslint/parser → typescript-estree.
4. eslint-plugin-import → @typescript-eslint/parser → typescript-estree.
5. typescript-eslint → @typescript-eslint/eslint-plugin → @typescript-eslint/parser → typescript-estree.
6. typescript-eslint → @typescript-eslint/eslint-plugin → @typescript-eslint/type-utils → typescript-estree.
7. typescript-eslint → @typescript-eslint/eslint-plugin → @typescript-eslint/type-utils → @typescript-eslint/utils → typescript-estree.
8. typescript-eslint → @typescript-eslint/eslint-plugin → @typescript-eslint/utils → typescript-estree.
9. typescript-eslint → @typescript-eslint/parser → typescript-estree.
10. typescript-eslint → typescript-estree.
11. typescript-eslint → @typescript-eslint/utils → typescript-estree.

Versioned baseline raw findings are preserved in the [spike snapshot](../experiments/auth-spike/evidence/dependency-audit.json). Better Auth and application runtime dependencies are not on these paths. Development tooling can still be attacked through hostile repository/configuration inputs; dev-only is not a waiver.

## Current official upstream options

- [Official advisory](https://api.github.com/advisories/GHSA-g3hv-75wg-m249): affected>=7,<11.0.1; first fixed11.0.1; amplification requires attacker-controlled globparts with optimizationLevel>=2.
- [Stable TypeScript-ESLint release](https://github.com/typescript-eslint/typescript-eslint/releases/tag/v8.72.1) and npm metadata: latest8.72.1 still declares minimatch^10.2.2. The advisory reports no patched10 range, and no maintained stable TypeScript-ESLint release adopting11 was found in this bounded review. Canary8.72.2-alpha is not selected.
- Stable eslint-config-next remains16.4.5, with typescript-eslint^8.56.0. A routine in-range refresh does not resolve the advisory.
- ESLint10.14.0 exists, but eslint-plugin-react7.37.5 declares peers only through^9.7.0. An unrelated major lint/framework upgrade is not an API-compatible shortcut.
- [Current stable v11.0.5 package](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.5/package.json) preserves CJS/ESM named exports and supports Node20/>=22, including selected Node24.19.0 and all declared project engines. The first-fixed11.0.1 GitHub release lookup was404, but its tagged source/npm metadata exist; that lookup is not proof of absence.
- [v10→v11 comparison](https://github.com/isaacs/minimatch/compare/v10.2.6...v11.0.5): a substantial non-RegExp matcher rewrite, not a universal drop-in guarantee. New runtime matcher dependency and brace-expansion are audited from the actual lockfile.
- A final registry check found latest stable11.0.5 (published2026-11-05). [Changes after first-fixed11.0.1](https://github.com/isaacs/minimatch/compare/v11.0.1...v11.0.5) include additional preprocessing bounds, caching and numeric-range matching. The first-fixed candidate passed the full local gate, but is superseded by11.0.5 with every required gate repeated; results are not carried over between versions.

## Selected minimal remediation

A temporary, exact-parent pnpm compatibility exception in [workspace configuration](../pnpm-workspace.yaml):

```yaml
overrides:
  "@typescript-eslint/typescript-estree@8.72.1>minimatch": "11.0.5"
```

This changes only that package-version dependency edge (across any resolved peer instances), NOT every minimatch consumer. Unrelated3.1.5 consumers, ESLint9.39.5, Next/config16.4.5, TypeScript6.0.3 and all Better Auth/Prisma/pg pins remain. No audit ignore, severity threshold, package exclusion, rule removal, broad override or prerelease.

**Important:**11.0.5 is outside typescript-estree's declared^10.2.2 dependency range. This is a deliberately bounded repository compatibility exception, not an upstream-supported semver update. Keep it only if the exact consumer/API and full regression/audit gates pass. Do not generalize it to other packages/versions.

## Consumer and rule compatibility

Source review of the active typescript-estree8.72.1 distribution found only one minimatch use: named CJS `minimatch(relativeFilePath,pattern,{dot:true})` in useProgramFromProjectService. It consumes no class, regex, matcher-internal or makeRe API. Official [v11 source](https://raw.githubusercontent.com/isaacs/minimatch/v11.0.5/src/index.ts) retains that signature/boolean contract and dot option.

Normal project ESLint configuration does not enable projectService/allowDefaultProject, so a clean ordinary lint run alone is insufficient evidence. Added [real ESLint compatibility tests](../tests/unit/eslint-compatibility.test.ts) resolve the module from the actual estree dependency context, exercise ordinary/dot/nested/brace/negated patterns on both platform modes, confirm unrelated React consumer version, and execute real typed projectService default-project matching with accepted and rejected virtual files. No ignored invalid-code fixture files or app tsconfig changes are needed.

Seven representative rules across six existing plugin families are exercised without stubs: Next, React, hooks, jsx-a11y, TypeScript explicit-any/unused-vars and import anonymous-default-export; warning-level rules count too. Typed unsafe-call positives/negatives exercise the affected matching branch. Before changing dependencies, the baseline plugin/typed probes passed9/9 (nine other candidate-specific cases were deliberately unselected, not removed from the final suite).

The known caller passes no optimizationLevel2 and its upstream default-project validator rejects `**`; documented exploit preconditions are not present at that call. This narrows observed exposure but does not erase an affected-package audit finding or justify suppressing it. v11 can still differ for unconsumed APIs/pathological patterns. Independent read-only review conditionally accepted the exact exception pending execution gates, not unrestricted semantic equivalence. The11.0.5 delta review confirmed the bounded256-pattern cache is compatible with this consumer's fixed plain options and current-path matching; repeated hit/miss cases exercise reuse. Large numeric-brace ranges and arbitrary glob-language equivalence remain outside this matrix. Upstream currently skips Windows Node22/24 in its own CI, so this project's actual native Windows24 tests and final Ubuntu CI are the relevant platform evidence, not an upstream Windows24 certification.

## Validation and final decision

The first-fixed11.0.1 evaluation passed the full local gate. Every required gate was then executed again against the selected current stable11.0.5; the table below records that completed rerun (no results were carried over):

| Check                                                    | Actual result                                                         |
| -------------------------------------------------------- | --------------------------------------------------------------------- |
| Frozen-lockfile installation                             | PASS                                                                  |
| Application and independent auth-spike TypeScript checks | PASS                                                                  |
| Ordinary ESLint and representative real plugin/API tests | PASS                                                                  |
| Unit suite                                               | **88/88 PASS**, including69unchanged tests +19new compatibility tests |
| PostgreSQL integration                                   | **44/44 PASS**                                                        |
| Better Auth security spike                               | **78/78 PASS**, existing code/assertions unchanged                    |
| Production build                                         | PASS                                                                  |
| Fixture-mode full E2E                                    | **56 PASS,6 intentional project/pointer SKIP**                        |
| Database-mode full E2E                                   | **56 PASS,6 intentional project/pointer SKIP**                        |
| Real missing-database/invalid-source HTTP failure probes | PASS;500/no fixture fallback/no response credential leak              |
| Unfiltered full dependency audit                         | **EXIT0, no known vulnerabilities reported**                          |
| Peer dependency check                                    | PASS; does not imply upstream semver endorsement of the exception     |
| Independent static diff/consumer/test review             | No actionable findings; no independent test execution/certification   |

The same62 browser project cases ran in each mode, not124unique scenarios. Only two package nodes changed in the lockfile: replace minimatch10.2.6 with11.0.5 and add @isaacs/nonrecursive-glob-match1.1.0 (published range^1.1.0); existing brace-expansion5.0.12 is retained. No other dependency versions, root manifest, rule config, workflow/audit policy, application source, catalog migration/schema, auth experiment or existing test changed.

Owned BookStore catalog/auth clusters were stopped in a finally block after validation; no other service/database was used or stopped. Existing ESLint9 support warning and pg8 query-queue deprecation were not suppressed. The original nonzero audit snapshot remains historical evidence.

**Local decision: GO for review of this narrowly scoped remediation, conditional on exact-final-HEAD CI.** Final commit/run/job results and downloaded actual audit/security artifacts are recorded in the PR completion comment after push; local results are not substituted for CI. Keep PR#3 Draft and unmerged. This resolves the dependency gate only, not the unapproved/full authentication boundary.

## Maintenance and residual risk

Retire this exception when a maintained upstream release declares a patched range or a supported fixed10 release becomes available. Any upgrade of estree8.72.1 requires rechecking the caller, dependency range and tests; the version-qualified exception must not silently follow unrelated major changes. Preserve the full audit CI gate and new plugin/API regression coverage. ESLint9 support debt and full authentication operational gates remain separate concerns; an audit fix does not authorize production authentication or merging PR#3.
