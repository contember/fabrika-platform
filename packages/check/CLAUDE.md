# @fabrika/check

The application checker (D11 of the framework plan): a small syntactic checker over an application's source
tree. It stops the honest shortcuts a coding agent takes around the framework. It is not a boundary: an aliased or
indirect call can escape a rule, and the runtime checks stay the real defence. A form spelled out directly must not
escape. Biome stays the linter for this repository's own code; this package is for applications. Assumes the root
CLAUDE.md.

Published (`publishConfig.access: public`), because applications run it in their own build.

```bash
bun run typecheck
bun test                    # rules · direct-forms · spike-contract · cli
bun src/cli.ts <app-root>   # what an application's build runs as `fabrika-check`
```

- Library: `checkApplication({ root, files? }) → Promise<Finding[]>`. Without `files` it reads the tree under
  `root`; with `files` (path relative to the root → text) it reads nothing from disk, as a caller with the files of
  a commit needs.
- Bin: `fabrika-check [<root>]` prints one line per finding,
  `file:line:col rule-id message (allowed form: …)`, then a count on stderr. Exit 0 clean, 1 with findings, 2 on a
  usage or read error.

| Module             | What it owns                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `check.ts`         | `checkApplication`, the disk reader, and the order the rules run in.                                 |
| `ast.ts`           | `@babel/parser` with `typescript` + `estree` (+ `jsx` for `.tsx`/`.jsx`), and structural readers.    |
| `graph.ts`         | The one static resolver: what a name denotes through consts, imports and exports, without executing. |
| `layout.ts`        | The application file layout the rules read, which files are read, and Bun's resolution candidates.   |
| `references.ts`    | Every way a module names another, and which names a direct load takes.                               |
| `resolution.ts`    | The application's own import mappings: `imports` in `package.json`, `paths` in `tsconfig.json`.      |
| `finding.ts`       | The rule ids, the `Finding` shape and its one-line format.                                           |
| `rules/literal.ts` | D5: the contract, its schema modules and `src/db/tables.ts` are literals, across their import graph. |
| `rules/*.ts`       | One file per rule group.                                                                             |

Tests: `rules.test.ts` holds a refused and an allowed fixture for each rule id; `direct-forms.test.ts` holds the
directly spelled forms each rule must also refuse, and the documented escapes.

## The rules

| Rule id                      | Refuses                                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `literal`                    | anything but the literal subset below in the contract graph, including every runtime import and export of its modules                                                                     |
| `forbidden-import`           | database drivers (Kysely included), S3 clients (`aws-sdk` too), `jose`, `node:http`/`https`/`http2`/`net`/`tls`/`dgram`, `child_process`                                                  |
| `unchecked-import`           | an import outside what the checker reads: above the root, absolute or `file:`, into `node_modules`/`dist`/a dot-directory, also through an import map or `tsconfig` path; a symbolic link |
| `forbidden-global`           | `Bun.sql`/`SQL`/`S3Client`/`s3`/`serve`/`connect`/`listen`/`udpSocket`/`spawn`/`spawnSync`/`$`, the same from `bun` by any load or re-export, `Bun` as a bare value                       |
| `raw-sql`                    | an `…sql` tagged template, `sql(…)`, `….sql.raw`/`lit`/`ref`/`id`/`table`/`val`/`join`/`unsafe`, importing `sql`                                                                          |
| `type-assertion`, `any-type` | `as T` and `<T>x` except `as const`; `any` anywhere                                                                                                                                       |
| `suppression-comment`        | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `oxlint-disable`                                                                                       |
| `capability-widening`        | `Ref<…>` / `Within<…>` with `string`, or a union containing it, as a type argument                                                                                                        |
| `prototype-assignment`       | writes and `delete` through `.prototype`/`.__proto__`/`Object.getPrototypeOf(…)`, `setPrototypeOf`, `defineProperty`/`assign` onto them                                                   |
| `env-read`                   | `process.env`, `Bun.env`, `env` from `node:process` by any load or re-export, `process` as a bare value — outside the generated entrypoint                                                |
| `public-env`                 | `import.meta.env` except a static `import.meta.env.FABRIKA_PUBLIC_*`                                                                                                                      |
| `cross-app-fetch`            | `fetch`, `fetch.call` or `fetch.apply` of an absolute URL whose prefix is static (literal, template head, `+` concatenation, `new URL`)                                                   |
| `key-literal`                | `px_` in any string, in a template's raw or decoded text, or in a JSON string                                                                                                             |
| `client-identity`            | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId` (or snake_case) other than the `from` of an `in`/`on` access                                                   |
| `sensitive-log`              | a `console.*` argument that is, or contains, an error object, a request, headers or an environment; `new …Error`/`Request`/`Headers`                                                      |
| `unsafe-html`                | `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`                                                                                                                 |
| `dynamic-code`               | `eval` (also `globalThis.eval`), `Function(…)`/`new Function(…)`/`Function.call`/`apply`, a string passed to `setTimeout`/`setInterval`                                                   |
| `migration-name`             | a file in `db/migrations/` not named `YYYYMMDDHHMMSS_slug.sql` with a real UTC timestamp, or in a subdirectory                                                                            |
| `crontab`                    | a `zerops.yaml` setup whose `run.crontab` is not exactly the contract's `c.cron` jobs with explicit, equal timings; a background `run.start`                                              |
| `skipped-test`               | `.skip`, `.only`, `.todo`, `.skipIf`, `.if`, `.todoIf`, `.failing`, `xit`/`fit`/… in test files                                                                                           |
| `test-without-assertion`     | a `test`/`it` registration (also `.concurrent`, `.each(…)(…)`) that runs no matcher on `expect(…)` and no `expect…`/`assert…` helper                                                      |
| `generated-test-hash`        | a generated isolation test whose content no longer matches its header hash, or whose header is not the first line                                                                         |
| `parse-error`                | a source file the parser does not accept                                                                                                                                                  |

## The literal subset (shared with B1)

The static contract reader (B1) must accept exactly what `rules/literal.ts` accepts. Change both together.

- **Values:** strings, numbers (`-` before a number), booleans, `null`, templates without `${…}`, object and array
  literals without spreads, computed keys, methods or holes; `x as const`, `x satisfies T`. A regular-expression
  literal only as the argument of `.regex()`.
- **Names:** a top-level `const` of the module, or a named import of an exported literal `const` from a relative
  module (export aliases are followed). A const defined through itself is refused. Every runtime import and every
  export of a literal module is checked, used or not; no side-effect import, namespace import of a relative module
  or re-export with a source.
- **Builders:** `z` (named or namespace) from `zod/v4`; `defineContract` from `@fabrika/app/contract`, called once
  as `defineContract(vocabulary, (c) => ({ … }))`; `defineTables` from `@fabrika/db`, as
  `defineTables<DB, Action>(columns)({ … })`, with `columns` imported from the generated
  `src/db/schema.generated.ts`.
- **Functions:** an inline arrow with one parameter and an expression body, only as the second argument of
  `defineContract` and as `procedures` in the options of `c.link(path, { … })`. Its parameter is used only as
  `c.<builder>(…)`: `rpc`, `query`, `mutation`, `link`, `spa`, `health`, `form`, `webhook`, `files`, `cron`, `export`.
- **Schemas:** `z.<factory>(…)` then any number of `.<method>(…)`, each called.
  - factories: `strictObject`, `string`, `number`, `int`, `boolean`, `null`, `literal`, `enum`, `array`, `tuple`,
    `union`, `discriminatedUnion`, `record`, `optional`, `nullable`, `uuid`, `email`, `url`, and
    `z.iso.date`/`datetime`/`time`/`duration`;
  - methods: `min`, `max`, `length`, `nonempty`, `email`, `uuid`, `url`, `startsWith`, `endsWith`, `includes`,
    `regex`, `int`, `positive`, `negative`, `nonnegative`, `nonpositive`, `gt`, `gte`, `lt`, `lte`, `multipleOf`,
    `optional`, `nullable`, `nullish`, `default`, `describe`, `array`, `or`, and on a strict object `extend`,
    `pick`, `omit`, `partial` (zod 4 keeps them strict);
  - refused by name: `z.object` (strips undeclared keys; use `z.strictObject`), and `transform`, `refine`,
    `superRefine`, `preprocess`, `overwrite`, `check`, `pipe`, `catch`, `custom`, `lazy`, `function`, `instanceof`,
    `codec`, `passthrough`, `loose`, `looseObject`, `catchall`. Anything else, `parse` included, is outside the subset.
  - refused by combination, in one chain, because the artifact keeps a string's checks unordered: two formats
    (`uuid`, `email`, `url`, `z.iso.*`); `url` with any other string check (it rewrites the value the later checks
    see); `startsWith`, `endsWith` or `includes` with a format. `@fabrika/app`'s `compileContract` refuses the same
    combinations, and also a `.default()` on a discriminated union's discriminator, which a chain cannot show.

## Documented escapes (D11)

Each has a fixture in `direct-forms.test.ts` that asserts it passes, so that closing one is a visible change:

- test registrations in a helper module that a test file imports (test rules apply to test files by name);
- a global reached through a computed member and destructured (`const { serve } = globalThis['Bun']`);
- an alias of `fetch`; a renamed capability type (`Ref as R`); a namespace alias of the test API.

## Invariants

- **NO SUPPRESSION SYNTAX, EVER.** The checker recognises no ignore comment, no allowlist file and no per-rule
  switch. Every escape hatch would be the first thing an agent reaches for when a rule blocks it. A suppression
  comment meant for another tool is itself a finding.
- **Every finding names the allowed form.** Over MCP the build log is the agent's only feedback, so a finding
  without a way forward is a dead end. Keep `allowed` concrete.
- **One static resolver.** Rules that need to know what a name denotes ask `ModuleGraph`; do not add a second
  resolution path to a rule, or the rules drift apart on the same source.
- **The layout constants in `layout.ts` are a contract with other work units.** `fabrika/entry.generated.ts`
  (A4 writes it), `db/migrations/` (A9), the crontab command `fabrika job run <name>` with `allContainers: false`
  (A15) and the generated-test header `// @generated by fabrika db test-scaffold sha256:<hex>`, whose hash is the
  SHA-256 of everything after the first line (A11, `generatedTestHeader`). Change one only together with its
  producer.
- **`@babel/parser` is pinned exactly (8.0.7).** It is plain JavaScript and also runs in a Worker, which B1 needs.
  A parser upgrade can move positions and change node shapes; rerun the spike fixture test.
- **Read nothing outside the checked set.** `node_modules`, `dist` and dot-directories are skipped, and symbolic
  links are reported, never followed; `unchecked-import` is what keeps code from hiding there.

## Notes

- The SPA rules of the framework document (`import.meta.env`, `innerHTML`, `eval`) apply to every file, because the
  server has no DOM to lose and Bun's `import.meta.env` is `process.env`.
- `cross-app-fetch` refuses every absolute URL with a static prefix: statically, another application's origin and a
  third party's look the same.
- A setup in `zerops.yaml` without a `run` section is not checked for jobs; every other setup carries them all.
- Not here yet: squawk rules and destructive-migration markers (deferred, not in v1), deletion of a generated test (A11), timers as
  job substitutes (A15), store functions that take bare ids (A8b).
