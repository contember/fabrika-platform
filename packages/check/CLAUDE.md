# @fabrika/check

The application checker (D11 of the framework plan): a small syntactic checker over an application's source
tree. It stops the honest shortcuts a coding agent takes around the framework. It is not a boundary: an aliased or
indirect call can escape a rule, and the runtime checks stay the real defence. Biome stays the linter for this
repository's own code; this package is for applications. Assumes the root CLAUDE.md.

Published (`publishConfig.access: public`), because applications run it in their own build.

```bash
bun run typecheck
bun test                    # rules.test.ts · spike-contract.test.ts · cli.test.ts
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
| `layout.ts`        | The application file layout the rules read, and which files are read at all.                         |
| `references.ts`    | Every way a module names another: imports, re-exports, `import()`, `require()`.                      |
| `finding.ts`       | The rule ids, the `Finding` shape and its one-line format.                                           |
| `rules/literal.ts` | D5: the contract, its schema modules and `src/db/tables.ts` are literals, across their import graph. |
| `rules/*.ts`       | One file per rule group; `rules.test.ts` has a refused and an allowed fixture for each rule id.      |

## The rules

| Rule id                      | Refuses                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `literal`                    | anything but literals, `c.*`/`z.*`/`define*` calls and `const` imports of literals in the contract graph                                |
| `forbidden-import`           | database drivers (Kysely included), S3 clients, `jose`, `node:http`/`https`/`http2`/`net`/`tls`/`dgram`, `child_process`                |
| `unchecked-import`           | a relative import that leaves the root or enters `node_modules`, `dist` or a dot-directory                                              |
| `forbidden-global`           | `Bun.sql`/`SQL`/`serve`/`spawn`/`spawnSync`/`connect`/`listen`/`udpSocket`/`$`, the same imported from `bun`, `Bun` as a bare value     |
| `raw-sql`                    | an `sql` tagged template, `sql(…)`, `sql.raw`/`lit`/`ref`/`id`/`table`/`val`/`join`/`unsafe`, importing `sql`                           |
| `type-assertion`, `any-type` | `as T` and `<T>x` except `as const`; `any` anywhere                                                                                     |
| `suppression-comment`        | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `oxlint-disable`                                     |
| `capability-widening`        | `Ref<…>` / `Within<…>` with `string` as a type argument                                                                                 |
| `prototype-assignment`       | writes through `.prototype`/`.__proto__`, `setPrototypeOf`, `defineProperty`/`assign` onto a prototype                                  |
| `env-read`                   | `process.env`, `Bun.env`, `env` from `node:process`, `process` as a bare value — outside the generated entrypoint                       |
| `public-env`                 | `import.meta.env` except a static `import.meta.env.FABRIKA_PUBLIC_*`                                                                    |
| `cross-app-fetch`            | `fetch` of a literal absolute URL (`https://…`, `//…`, `new URL('https://…')`)                                                          |
| `key-literal`                | `px_` in any string or template literal                                                                                                 |
| `client-identity`            | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId` (or snake_case) other than the `from` of an `in`/`on` access |
| `sensitive-log`              | a `console.*` argument that is an error object, a request, headers or an environment                                                    |
| `unsafe-html`                | `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`                                                               |
| `dynamic-code`               | `eval`, `Function(…)`/`new Function(…)`, a string passed to `setTimeout`/`setInterval`                                                  |
| `migration-name`             | a file in `db/migrations/` not named `YYYYMMDDHHMMSS_slug.sql` with a real UTC timestamp, or in a subdirectory                          |
| `crontab`                    | a `zerops.yaml` setup whose `run.crontab` is not exactly the contract's `c.cron` jobs; a background `run.start`                         |
| `skipped-test`               | `.skip`, `.only`, `.todo`, `.skipIf`, `.if`, `.todoIf`, `.failing`, `xit`/`fit`/… in test files                                         |
| `test-without-assertion`     | a `test`/`it` callback that calls no `expect…` or `assert…`                                                                             |
| `generated-test-hash`        | a generated isolation test whose content no longer matches its header hash                                                              |
| `parse-error`                | a source file the parser does not accept                                                                                                |

## Invariants

- **NO SUPPRESSION SYNTAX, EVER.** The checker recognises no ignore comment, no allowlist file and no per-rule
  switch. Every escape hatch would be the first thing an agent reaches for when a rule blocks it. A suppression
  comment meant for another tool is itself a finding.
- **Every finding names the allowed form.** Over MCP the build log is the agent's only feedback, so a finding
  without a way forward is a dead end. Keep `allowed` concrete.
- **The layout constants in `layout.ts` are a contract with other work units.** `fabrika/entry.generated.ts`
  (A4 writes it), `db/migrations/` (A9), the crontab command `fabrika job run <name>` with `allContainers: false`
  (A15) and the generated-test header `// @generated by fabrika db test-scaffold sha256:<hex>`, whose hash is the
  SHA-256 of everything after the first line (A11, `generatedTestHeader`). Change one only together with its
  producer.
- **The literal rule's choices are shared with the static contract reader (B1).** `as const` and `satisfies`
  pass, every other `as` is refused; an identifier is a top-level `const` of the file or a named import of a
  literal `const` from a relative module; an arrow function only as a builder callback with one parameter and an
  expression body; `z` comes from `zod/v4` only; `transform`, `refine`, `superRefine`, `preprocess`,
  `passthrough`, `loose`, `looseObject`, `catchall`, `catch`, `pipe` and `custom` are refused in a schema chain.
- **`@babel/parser` is pinned exactly (8.0.7).** It is plain JavaScript and also runs in a Worker, which B1 needs.
  A parser upgrade can move positions and change node shapes; rerun the spike fixture test.
- **Read nothing outside the checked set.** `node_modules`, `dist` and dot-directories are skipped, and symbolic
  links are not followed; `unchecked-import` is what keeps code from hiding there.

## Notes

- The SPA rules of the framework document (`import.meta.env`, `innerHTML`, `eval`) apply to every file, because the
  server has no DOM to lose and Bun's `import.meta.env` is `process.env`.
- `cross-app-fetch` refuses every literal absolute URL: statically, another application's origin and a third
  party's look the same.
- A setup in `zerops.yaml` without a `run` section is not checked for jobs; every other setup carries them all.
- Not here yet: squawk rules and destructive-migration markers (A9), deletion of a generated test (A11), timers as
  job substitutes (A15), store functions that take bare ids (A8b).
