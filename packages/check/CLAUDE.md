# @fabrika/check

The application checker (D11 of the framework plan): a small syntactic checker over an application's source
tree. It stops the honest shortcuts a coding agent takes around the framework. It is not a boundary: an aliased or
indirect call can escape a rule, and the runtime checks stay the real defence. A form spelled out directly must not
escape. oxlint stays the linter for this repository's own code; this package is for applications. Assumes the root
CLAUDE.md.

Published (`publishConfig.access: public`), because applications run it in their own build. It also holds the
static contract reader (B1), which Control runs on the files of a commit.

```bash
bun run typecheck
bun test                    # rules · direct-forms · generated · structure · spike-contract · cli · reader · differential · colocated · colocated-scale · vite · dialect
bun src/cli.ts <app-root>   # what an application's build runs as `fabrika-check`
```

- Library: `checkApplication({ root, files? }) → Promise<Finding[]>`. Without `files` it reads the tree under
  `root`; with `files` (path relative to the root → text) it reads nothing from disk, as a caller with the files of
  a commit needs.
- `Finding.severity` is its rule's (`REFUSAL_RULE_IDS`, `HINT_RULE_IDS` in `finding.ts`; the `Finding` union ties
  them). A **refusal** fails the check. A **hint** reports a step out of the application architecture
  ([`docs/reference/application-architecture.md`](../../docs/reference/application-architecture.md)); it is checker
  output only, never part of the contract or the approval snapshot.
- Bin: `fabrika-check [--hints] [<root>]` prints one line per refusal, `file:line:col rule-id message (allowed form: …)`,
  then one line with the number of hints and how to list them, then `N refusals, M hints` on stderr. `--hints` lists
  the hints in the same form under the heading `Hints — …` instead of that line: a large application has hundreds. The
  platform build (and so `run_checks`) runs it without the flag. Exit 0 with no refusal (hints only
  included), 1 with a refusal, 2 on a usage or read error.
- `--packed <release-manifest.json>` (`packed.ts`, `CheckInput.packed`): `package-replacement` accepts the tarballs of a
  local pack, their `file:` specifiers, an `overrides` block of them alone and their lockfile entries, when each file
  under the root hashes to the sha512 the manifest records ([ADR-0043](../../docs/decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)).
  The platform build never passes it; never make a configuration file or an environment variable turn it on.
- `--base <ref>` (`migration-base.ts`, `CheckInput.migrationBase`): the ref `migration-edited` compares with. Without it
  the bin takes the remote's default branch, says on stderr why it could not (a git work tree without one, a clone
  too shallow for the merge base) and checks the rest; outside a git work tree it compares nothing and says nothing,
  as in a deploy build. A `--base` it cannot read is a usage error (exit 2).
- **The shell slice** (`slice.ts`): every module the reader, the literal rule, `contractReaderInputs` and the SPA
  bundle read is read as its slice: each `<x>.query|mutation|cron|webhook(…).handle(<inline function>)` loses its
  `.handle(…)`, and so does every import specifier, function, const of an inline function and type that only those
  handlers used (followed until nothing more goes; an exported declaration, and one nobody uses, stays). Removed text
  becomes spaces, so every finding keeps its line and column. Control therefore never fetches, parses or runs a module
  only a handler imports; `boot`'s contract digest backs what the slice cannot see. Any other call of a member
  statically named `handle` (a named or wrapped function; `['handle'](…)`, `.handle!(…)`, a parenthesised, `as`,
  `satisfies` or `<T>` wrapped callee or receiver; a receiver that is no endpoint, job or webhook builder) is refused at
  its `handle` (rule `literal`), and its arguments, type arguments and wrapping types are removed all the same, so what
  it names is never requested either; its receiver stays and is sliced in turn. The checker runs the contract rules
  over the slices, reports their refusals for the modules of the shell graph, and runs every other rule over the whole
  module.
- **A developer's tools** (`tools/` at the root, `TOOLS_DIR`): code that runs on a developer's machine and never in the
  application, such as a command line typed against the contract (`createClient` with a service key). A module there
  is read by `checkToolModule` (`check.ts`) instead of the module rules: how it is written (`type-assertion`, `any-type`,
  `suppression-comment`, not in its tests; `capability-widening`), `key-literal`, a `declare module` of a trusted package
  (`package-replacement`) and the rules of its tests. The
  rest guard code that runs in the application, so a tool may spawn a process, read the environment and the files, and
  fetch any origin. The rules over the whole tree read `tools/` like any path (a symbolic link, the configuration
  `trust.ts` reads, a JSON string's key). What keeps a tool out of the application is `tool-import`: no module outside
  `tools/` loads one, no `[test] preload` names one, and no `package.json` lies under `tools/` (a workspace or a `file:` dependency would load
  it by name), so no entrypoint or bundle loads it. Its tests still run in the platform build's `bun test`, which
  runs before the checker, so they must pass without a keychain or a network. It is a fixed place, never a
  configuration or a list ([ADR-0071](../../docs/decisions/0071-an-application-keeps-its-developer-tools-in-tools.md)).
- Bun plugin: `@fabrika/check/bun-plugin` (`shellSlicePlugin({ root? })`, the working directory by default; the default
  export uses it) reads the shell graph under `root` as Control does, fails the build when the reader refuses it (a
  refused `.handle(…)` included), and loads each shell module, of every extension the reader reads, as its slice; the
  application's other modules load as they are. An SPA build that imports `fabrika.contract.ts` therefore holds no
  handler code, with every package bundled.
- Vite plugin: `@fabrika/check/vite-plugin` (`shellSlicePlugin({ root? })`, a structural part of Vite's `Plugin`, so the
  package depends on no Vite) loads the same slices (`shell-modules.ts`, which both plugins share) in Vite's `load`
  hook, `enforce: 'pre'`, and leaves every other module to Vite. It watches each shell module it loads
  (`addWatchFile`: Vite watches only its root, usually `web/`) and reads the shell graph again after any change
  (`watchChange`). The package ships TypeScript, so Vite runs on Bun (`bun --bun vite build`); Node refuses to strip
  types under `node_modules` (ADR-0052 decision 9).
- Source maps: `@fabrika/check/source-maps` finds a build's `*.map` files and uploads them to Operations with the
  run-scoped bearer Control minted (`uploadSourceMaps`; never throws, a refused or failed upload is `incomplete`).
  `collectSourceMaps` reads each map's logical path from its own `file` field (the Cloudflare runner);
  `collectAssetSourceMaps` names each map under an asset root by the URL path of the file it maps,
  `<prefix>/<path under dir>` without `.map`, as a browser names it in a stack frame. Bin: `fabrika-source-maps
  <root>` is the last step of a Zerops platform build, fetched by version like the checker. It reads
  `FABRIKA_SOURCE_MAP_UPLOAD` (destination and asset roots, JSON) and `FABRIKA_SOURCE_MAP_UPLOAD_KEY` (the bearer),
  prints only `sourceMapUploadReport` (`fabrika-source-maps: N uploaded, state=complete|incomplete`), which the
  provider reads back from the build log, and always exits 0. It never prints the bearer or an error object.
- Reader: `@fabrika/check/contract` exports `readContractSource(files, tables?) → ContractArtifact`,
  `readContract(files) → AnyContract`, `readTablesSource(files) → TablePolicies` and
  `readTablesDefinition(files) → Tables | null` (what `defineTables` returns). `files` holds
  `fabrika.contract.ts`, `src/db/tables.ts`, the modules their shell slices import (path → text) and every `package.json`,
  `tsconfig.json`, `jsconfig.json` and `bunfig.toml` that applies to them: the root's and those of each directory of
  such a module. For an import without an extension, `files` holds every candidate that
  exists, so the reader sees two of them. The reader cannot tell a missing file from an absent one, so the caller
  (Control, B6) supplies them all; nothing else is read. `contractReaderInputs(files, exists)` names them: given the
  paths that exist at a commit, it answers the ones still missing from `files`; the caller reads them and asks again
  until the answer is empty. `CHECKER_VERSION` is this package's version, which Control records in a snapshot. The
  reader throws `ContractSourceError` (findings with file, line, column and allowed form) for a form it refuses, and `ContractError` with the problems `compileContract` reports for a contract that does not compile.
  `readTablesSource` reads `src/db/tables.ts` and the modules it imports (the generated `src/db/schema.generated.ts`)
  under the same literal rule, and parses the column list and the policies of `defineTables` with `@fabrika/db/tables`' `readTables`,
  the parse `defineTables` runs; a policy it refuses is a `ContractSourceError` at the call. No `src/db/tables.ts` in
  `files` means no policies. `readContractSource` compiles against `readTablesDefinition` unless `tables` is given.

| Module                         | What it owns                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check.ts`                     | `checkApplication`, the disk reader, and the order the rules run in.                                                                                                                                                                                                                                                                                                                                                      |
| `ast.ts`                       | `@babel/parser` with `typescript` + `estree` (+ `jsx` for `.tsx`/`.jsx`), and structural readers.                                                                                                                                                                                                                                                                                                                         |
| `graph.ts`                     | The one static resolver: what a name denotes through consts, imports and exports, without executing.                                                                                                                                                                                                                                                                                                                      |
| `layout.ts`                    | The file layout the rules read, which files are read, and `resolveRelative` over Bun's candidates.                                                                                                                                                                                                                                                                                                                        |
| `dialect.ts`                   | `applicationDialect(files)`: SQLite when `fabrika.config.ts` default-exports a call of `@fabrika/provider-cloudflare`'s `defineApp`, read through `ModuleGraph`; Postgres otherwise, a missing config or a call of no static origin included. The CLI's `db` and `app dev` read it too.                                                                                                                                   |
| `references.ts`                | Every way a module names another, and which names a direct load takes.                                                                                                                                                                                                                                                                                                                                                    |
| `scope.ts`                     | Which declaration a name denotes at a node: the innermost scope that declares it.                                                                                                                                                                                                                                                                                                                                         |
| `resolution.ts`                | Import mappings in Bun's order per module: a builtin is never mapped; the first existing target of the nearest `tsconfig.json` `paths` (local `extends`); else the nearest `package.json` `imports`; exact key, then longest prefix, then longest key.                                                                                                                                                                    |
| `trust.ts`                     | Configuration that could redirect a package trusted by name; checker and reader both refuse it.                                                                                                                                                                                                                                                                                                                           |
| `jsonc.ts`                     | JSON with comments, without `Bun.JSONC`, so the reader parses `tsconfig.json` in a Worker.                                                                                                                                                                                                                                                                                                                                |
| `toml.ts`                      | The TOML subset `bunfig.toml` is read in, keys decoded as Bun decodes them; anything else is refused.                                                                                                                                                                                                                                                                                                                     |
| `inputs.ts`                    | `contractReaderInputs`: which files of a commit the reader needs, round by round.                                                                                                                                                                                                                                                                                                                                         |
| `limits.ts`                    | `CONTRACT_LIMITS`, the reader's resource budget.                                                                                                                                                                                                                                                                                                                                                                          |
| `finding.ts`                   | The rule ids, the `Finding` shape and its one-line format.                                                                                                                                                                                                                                                                                                                                                                |
| `rules/literal.ts`             | D5: the contract, its schema modules and `src/db/tables.ts` are literals, across their import graph.                                                                                                                                                                                                                                                                                                                      |
| `rules/contract.ts`            | What the reader refuses, run by the checker once the literal rule passes.                                                                                                                                                                                                                                                                                                                                                 |
| `rules/*.ts`                   | One file per rule group.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contract.ts`                  | `@fabrika/check/contract`: the reader's entry, which parses only the contract's import graph.                                                                                                                                                                                                                                                                                                                             |
| `slice.ts`                     | The shell slice: a module without its colocated handlers and what only they use, every position kept.                                                                                                                                                                                                                                                                                                                     |
| `bun-plugin.ts`                | `@fabrika/check/bun-plugin`: the Bun plugin that loads application modules as their slices, for the SPA build.                                                                                                                                                                                                                                                                                                            |
| `vite-plugin.ts`               | `@fabrika/check/vite-plugin`: the same slices in a Vite build or dev server.                                                                                                                                                                                                                                                                                                                                              |
| `shell-modules.ts`             | The shell graph read from disk, each module as its slice: what both plugins load.                                                                                                                                                                                                                                                                                                                                         |
| `rules/compile.ts`             | `checkContractCompiles`: what the reader refuses of `src/db/tables.ts`, and a contract that does not compile against its policies (`contract`).                                                                                                                                                                                                                                                                           |
| `rules/cloudflare.ts`          | `checkCloudflareContract`: on SQLite, what the compiled artifact declares that a Cloudflare application cannot run (`cloudflare-scan`, `cloudflare-job-segment`), and a mutation that declares an outside call (`cloudflare-held-call`), each reported at `fabrika.contract.ts` 1:1. The migrations' `cloudflare-current-timestamp`, `cloudflare-framework-name` and `cloudflare-view-trigger` are `rules/migrations.ts`. |
| `rules/platform-migrations.ts` | What the platform refuses of the migrations, before the push: Control's classifier at each refused statement (`migration-refused`, every dialect), and on SQLite the backup's plan of the schema the migrations build in memory (`backup-schema`, `withMigratedSqlite` + `describeOpsDumpSchema` + `planOpsDump`).                                                                                                        |
| `rules/migration-history.ts`   | `migration-edited`: each migration of the base that the tree changed (at its first changed line) or no longer holds.                                                                                                                                                                                                                                                                                                      |
| `migration-base.ts`            | The bin's base for it: `db/migrations/` at the merge base of HEAD and the remote's default branch, read with `git ls-tree` and one `git cat-file --batch`.                                                                                                                                                                                                                                                                |
| `rules/structure.ts`           | The application architecture: where a module sits (slice, part, SPA) and the refusals and hints of it.                                                                                                                                                                                                                                                                                                                    |
| `reader/value.ts`              | The literal subset read into values through `ModuleGraph`; `c.*` calls stay unapplied.                                                                                                                                                                                                                                                                                                                                    |
| `reader/schema.ts`             | Each `z` factory and method recorded as `@fabrika/app/schema`'s `DataSchema` and replayed against zod through its `replayStep` at once, its arguments and options checked; the build stays in the replay's bounded cache, so the read holds no zod graph.                                                                                                                                                                 |
| `reader/surface.ts`            | The values read into the `AnyContract` `defineContract` returns, builder by builder, as the kit does.                                                                                                                                                                                                                                                                                                                     |
| `reader/tables.ts`             | `src/db/tables.ts`: the `defineTables(vocabulary, columns)(policies)` arguments as plain values, for `readTables`.                                                                                                                                                                                                                                                                                                        |

Tests: `rules.test.ts` holds a refused and an allowed fixture for each rule id but the architecture's, which
`structure.test.ts` holds over `fixtures/architecture-app/` (a two-slice application in the target layout, its sources
named `*.ts.fixture` so this repository's typecheck skips them; until the reader reads that form, only the
architecture's rules are asserted on it); `direct-forms.test.ts` holds the
directly spelled forms each rule must also refuse, and the documented escapes. `generated.test.ts` holds the generated
modules: what they skip, what still applies, and `@buzola/codegen` 0.0.28's exact output
(`fixtures/buzola.gen.ts.fixture`). `reader.test.ts` holds every refusal
of the reader and its budget; `differential.test.ts` compiles each fixture contract from source and from the evaluated
module and expects the same artifact and canonical bytes (`fixtures/reader-forms/` holds every form the reader
accepts; `fixtures/clean-app/` is the clean application of the rule tests). Its paired cases (`fixtures/paired/`,
`.fixture` files) are written to a temporary directory and evaluated by Bun through `fixtures/paired-runner.mjs`:
each either gives the reader's artifact, or the reader refuses it and the test shows what Bun does instead. A fixture
directory that no table registers fails the test. Its staged-kit cases read `@fabrika/app`'s `kit-fixture/` (the slice
cases) and `fixtures/architecture-app/`, which Bun evaluates through `paired-runner.mjs` against its tables.
`colocated.test.ts` holds the slice itself: a handler-only module that throws at import is never requested or run; a
plugin build holds no handler code, with every package bundled and from a JavaScript shell module too, and `serve`
refuses it; a named, decorated, computed (`['handle']`) or non-null (`.handle!`) handler is refused before its module
is requested, and fails the build; every wrapped spelling slices to text that parses without what it names; the forms the
slice keeps are the literal rule's; and the whole check of `fixtures/architecture-app/` is clean. Each plugin build runs in a process of its own (`fixtures/plugin-build.mjs`): Bun's bundler
reads stale module state across plugin builds in one process. `vite.test.ts` builds `fixtures/architecture-app/`'s SPA with Vite
(`fixtures/vite-build.ts`, with and without the plugin), runs the page in happy-dom (`fixtures/vite-page.ts`) and sees
its one call go to the contract's path and its answer pass the output schema; it also holds the plugin's dev-server
hooks. `colocated-scale.test.ts` reads 200 colocated endpoints in 10 group modules.

## The rules

| Rule id                        | Refuses                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `literal`                      | anything but the literal subset below in the contract graph, including every runtime import and export of its modules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `contract`                     | what the static reader refuses once the contract is a literal (the wrong builder or value type for a field, a hand-written mount), and a schema `describeContract` refuses; what the reader refuses of `src/db/tables.ts`, and a contract that does not compile against its policies                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `forbidden-import`             | database drivers (Kysely included), S3 clients (`aws-sdk` too), `jose`, `node:http`/`https`/`http2`/`net`/`tls`/`dgram`, `child_process`, `@fabrika/db/framework` (the framework's binding of the data layer), `@fabrika/app/service` (the installation services' dispatcher); `boot` from `@fabrika/app/implement` outside a test file and the generated entrypoint                                                                                                                                                                                                                                                                                                                                                   |
| `test-only-import`             | outside a test file (`*.test.*`, `*.spec.*`, `__tests__/`): a load or re-export of `@fabrika/app/testing` (and its subpaths), `@fabrika/app/react/testing`, `@fabrika/db/testing` or `@fabrika/db/testing-sqlite`, directly, through an import map or a directory index, and of a test module, which may load it                                                                                                                                                                                                                                                                                                                                                                                                       |
| `unchecked-import`             | an import outside what the checker reads: above the root, absolute or `file:`, into `node_modules`/`dist`/a dot-directory/`fabrika/assets`, also through an import map or `tsconfig` path; `import()`, `require()`, `module.require()` or `import.meta.require()` of a computed specifier; a loader called through `.call`/`.apply`/`.bind` or `Reflect.apply`; `process.getBuiltinModule`; `import.meta.resolve`/`resolveSync`, `require.resolve`/`cache`, `Bun.resolve`/`resolveSync`; `module`/`node:module`, `resolve`/`resolveSync` from `bun`; a symbolic link; a relative import with two candidates or into a directory with a `package.json`; configuration that can redirect a trusted package (below)       |
| `forbidden-global`             | `Bun.sql`/`SQL`/`S3Client`/`s3`/`serve`/`connect`/`listen`/`udpSocket`/`fetch`/`spawn`/`spawnSync`/`$`, the same from `bun` by any load or re-export, `Bun` as a bare value; in a server module (under `src/`, not a test) any value use of `globalThis`, `global`, `self`, `window`, `Bun` or `WebSocket` (a `typeof` test, type positions and a name the module binds itself (a declaration, a parameter, a value import) stay; an ambient `declare` binds nothing)                                                                                                                                                                                                                                                  |
| `raw-sql`                      | a driver's or a builder's SQL: importing `sql`; a call, tagged template or `.raw`/`lit`/`ref`/`id`/`table`/`val`/`join`/`unsafe` of a name the module binds to an imported or loaded `sql` (alias included); a `<x>.sql` tagged template and `<x>.sql.<helper>`; never `ctx.sql(Row)` and its template, nor a parameter that holds the declared tag, whatever its name                                                                                                                                                                                                                                                                                                                                                 |
| `type-assertion`, `any-type`   | `as T` and `<T>x` except `as const`; `any` anywhere; not in a generated module or a test file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `suppression-comment`          | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `eslint-disable`, `oxlint-disable`; not in a generated module or a test file                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `capability-widening`          | `Ref<…>` / `Within<…>` with `string`, or a union containing it, as a type argument                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `prototype-assignment`         | writes and `delete` through `.prototype`/`.__proto__`/`Object.getPrototypeOf(…)`, `setPrototypeOf`, `defineProperty`/`assign` onto them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `framework-write`              | a write to a member of a value imported or loaded from `@fabrika/*` or `zod`, also through a package import map (assignment, also in a pattern, `++`, `delete`, `Object.defineProperty`/`defineProperties`/`assign`/`setPrototypeOf`, `Reflect.set`/`defineProperty`/`deleteProperty`/`setPrototypeOf`); a write through a prototype is `prototype-assignment`                                                                                                                                                                                                                                                                                                                                                         |
| `env-read`                     | `process.env`, `Bun.env`, `env` from `node:process` by any load or re-export, `process` as a bare value, outside the generated entrypoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `public-env`                   | `import.meta.env` except a static `import.meta.env.FABRIKA_PUBLIC_*`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `cross-app-fetch`              | `fetch`, `fetch.call` or `fetch.apply` of an absolute URL whose prefix is static (literal, template head, `+` concatenation, `new URL`), unless an `egress` entry of a site of the contract admits it (the prefix holds the origin and a `/`, `?` or `#` after it, or a template interpolates the first label alone under a declared `https://*.<domain>`), or a cron job declares `egress: 'public'` and the prefix is http(s) with a host not yet complete or one `publicEgressRefusal` admits                                                                                                                                                                                                                       |
| `url-endpoint`                 | `ctx.url('<id>', …)` with a literal id that names no procedure of the contract (checked when the contract compiles)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `on-conflict-index`            | `<table>.insert(values, { onConflict: { columns: [...] } })` with literal columns whose set is no `UNIQUE`/`PRIMARY KEY` or non-partial `CREATE UNIQUE INDEX` of that table in `db/migrations` (a table `src/db/tables.ts` declares)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `access-view-key`              | a table that names an access view (`access` of a table policy) whose key no migration makes unique on its own: a `PRIMARY KEY` or `UNIQUE` of that column alone, or a non-partial `CREATE UNIQUE INDEX` on it, minus a later `DROP INDEX`, `DROP CONSTRAINT` (by its declared or Postgres default name), `DROP COLUMN` or `DROP TABLE`, and following renames; a view as the target is not checked, and a name no migration creates as a table or a view is refused at `src/db/tables.ts` (ADR-0076). The view itself, its columns and its lack of a policy are checked by the policy parse                                                                                                                            |
| `key-literal`                  | `px_` in any string, in a template's raw or decoded text, or in a JSON string                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `client-identity`              | an input field `userId`, `ownerId`, `createdBy`, `tenantId`, `workspaceId` (or snake_case) other than the `from` of an `in`/`on` access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `sensitive-log`                | a `console.*` argument that is, or contains, an error object, a request, headers or an environment; `new …Error`/`Request`/`Headers`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `unsafe-html`                  | `dangerouslySetInnerHTML`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `dynamic-code`                 | `eval` (also `globalThis.eval`), `Function(…)`/`new Function(…)`/`Function.call`/`apply`, a string passed to `setTimeout`/`setInterval`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `migration-name`               | a file in `db/migrations/` not named `YYYYMMDDHHMMSS_slug.sql` with a real UTC timestamp, or in a subdirectory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `migration-edited`             | (bin only, in a git work tree) a migration of `db/migrations/` at the merge base of HEAD and the remote's default branch (`origin/HEAD`, else `origin/main` or `origin/master`; `--base <ref>` names another) that the tree changed (at its first changed line, a comment or whitespace included; line ends are compared without `\r`) or no longer holds (deleted or renamed). Every runner refuses a deploy whose applied file changed (ADR-0017), and Control refuses it before the build when the environment's last succeeded run deployed the file; this rule names the edit before the push, from history neither of them has: `migration-base.ts` reads it with git, and `CheckInput.migrationBase` carries it |
| `file-column-migration`        | a declared file column (`files` of a table policy) that no migration makes a foreign key to `fabrika_files (id)`, or that leads no index a migration creates (a partial index or one a later `DROP INDEX` removes does not count)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cloudflare-scan`              | for an application on Cloudflare: a file kind with `scan: true`; no scanner runs there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cloudflare-job-segment`       | for an application on Cloudflare: a job whose `timeoutMs` exceeds `CLOUDFLARE_MAX_JOB_SEGMENT_MS` (`@fabrika/app/contract`, 14 minutes); the deploy refuses it from 0.9 on, and longer work chunks through claims                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cloudflare-current-timestamp` | for an application on Cloudflare: `DEFAULT CURRENT_TIMESTAMP` (or `DEFAULT (CURRENT_TIMESTAMP)`) in a file of `db/migrations/`; SQLite stores `YYYY-MM-DD HH:MM:SS`, which every read of the table refuses as `unexpected_row`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cloudflare-framework-name`    | for an application on Cloudflare: a `fabrika_*` name in a file of `db/migrations/`, in any case, quoted, bracketed or as a string, but `fabrika_files` right after `REFERENCES`; a view or trigger over a framework table would reach what `ctx.sql`'s name rule keeps it from                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `cloudflare-view-trigger`      | for an application on Cloudflare: a `CREATE TRIGGER` in a file of `db/migrations/` whose timing is `INSTEAD OF`, in any case, temporary or not; SQLite takes `INSTEAD OF` only on a view, and a view is read-only (ADR-0072)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `migration-refused`            | a statement of a file in `db/migrations/` that Control's migration classifier refuses (`classifyMigrations`, against the access tables of `src/db/tables.ts`, in the application's dialect), at its file and line; Control refuses a deploy that brings it, and its run log names neither                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `backup-schema`                | for an application on Cloudflare: a migrated schema the backup refuses (`planOpsDump`, ADR-0070 section 2), at the newest migration naming the table; every migration deploy backs up first, so it blocks every migration after                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `package-replacement`          | a trusted name (`@fabrika/*`, `zod`) as any `package.json`'s `name`, which Bun resolves to the application itself; an `exports` map in the root one; `patchedDependencies`/`overrides`/`resolutions` in a `package.json`; a non-registry specifier of `@fabrika/*` or `zod`; their `bun.lock` entry without a registry version and a `sha512-` hash; another registry in `bunfig.toml` or `.npmrc`; `declare module` of one                                                                                                                                                                                                                                                                                            |
| `skipped-test`                 | `.skip`, `.only`, `.todo`, `.skipIf`, `.if`, `.todoIf`, `.failing`, `xit`/`fit`/… in test files (global, or imported from `bun:test`; a helper the file binds itself of that name stays); `[test] root`, `pathIgnorePatterns` or `retry` in `bunfig.toml`                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test-without-assertion`       | a `test`/`it` registration (also `.concurrent`, `.each(…)(…)`) that runs no matcher on `expect(…)` and no `expect…`/`assert…` helper                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `mock-module`                  | `mock.module(…)` of `bun:test`, of a `@fabrika/*` specifier, or with a computed specifier, anywhere in the application                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `parse-error`                  | a source file the parser does not accept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `spa-server-import`            | in a module under `web/` (not a test): a value load, also through a schema module it loads, of an application module other than `fabrika.contract.ts`, `src/schemas.ts`, `src/schemas/**`, `src/shared/**` and `web/**`, of a `@fabrika/*` module other than `@fabrika/app/client`, `@fabrika/app/react` and `@fabrika/ui` (its stylesheets and `@fabrika/ui/challenge` included), or of a Bun or Node builtin in either spelling (`isBuiltin`)                                                                                                                                                                                                                                                                        |
| `layer-import`                 | in `src/<slice>/logic.ts` and `queries.ts`: a value load, also through the local modules it loads (barrels, `export *`, literal `import()`), of a `@fabrika/*` module other than `@fabrika/app` and `@fabrika/db`; the test kits stay `test-only-import`                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `shared-import`                | in a module under `src/shared/` (not a test): a value load of anything but `zod/v4`, `@fabrika/app/schema` and other modules under `src/shared/` (a slice, `src/db/`, `@fabrika/*`, a builtin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `tool-import`                  | in a module outside `tools/` (a test and `fabrika.config.ts` included): a value load or re-export of a module under `tools/`, also through an import map, a `tsconfig` path or a literal `import()` (a type-only import stays); a `package.json` under `tools/`                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

The hints (severity `hint`; the architecture's not in test files, the generated entrypoint or a generated module):

| Rule id                | Reports                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `logic-data-access`    | `src/<slice>/logic.ts` that value-loads `@fabrika/db`, a slice's `queries.ts` or a module of `src/db/`, or uses `ctx.db`/`ctx.sql`                                                                   |
| `cross-slice-queries`  | a module of the slice `src/<a>/` that value-loads `src/<b>/queries.ts`                                                                                                                               |
| `handler-location`     | `.handle(…)` on `<x>.query`/`mutation`/`cron`/`webhook`/`export(…)` outside `src/<slice>/endpoints.ts`                                                                                               |
| `data-access-location` | `ctx.db` or `ctx.sql` outside a slice's `endpoints.ts`, `queries.ts` and `logic.ts`                                                                                                                  |
| `sql-undeclared`       | `ctx.sql` or `tx.sql` in a `.handle(…)` whose procedure options (an object literal, no spread) declare no `sql`; names the site                                                                      |
| `cloudflare-held-call` | for an application on Cloudflare: a mutation of the compiled contract that declares `egress` or `connect`; it waits for that call inside the object's transaction, which holds the whole environment |

**Generated modules** (`isGeneratedModule` in `layout.ts`): a source file named `<name>.gen.<ext>` or
`<name>.generated.<ext>` that opens with a comment on line 1, before any statement, holding `@generated` or `auto-generated` (any case),
as `fabrika db codegen`, `fabrika app build` and `@buzola/codegen` write them. A generator's output is not held to how
source is written: `type-assertion`, `any-type`, `suppression-comment` and the architecture's four hints skip it.
Every other rule applies to it in full, `capability-widening`, `spa-server-import`, `env-read` and the literal subset
of the contract graph included. One fixed convention, no per-file or per-rule switch; it is a documented escape (below).

## The literal subset (shared with B1)

The static contract reader (B1) runs `rules/literal.ts` first and reads exactly its forms; it refuses more only
where the types refuse too (see below). Change the rule, `reader/value.ts` and `reader/schema.ts` together.

- **Values:** strings, numbers (`-` before a number), booleans, `null`, templates without `${…}`, object and array
  literals without spreads, computed keys, methods, holes or a `__proto__` key; `x as const`, `x satisfies T`. A
  regular-expression literal only as the argument of `.regex()`.
- **Names:** a top-level `const` of the module declared above its use (the module reads it eagerly; an unused
  forward reference is refused too), or a named import of an exported literal `const` from a relative module (export
  aliases are followed). A const whose own initializer is refused is reported there, at the offending expression, and
  not again at each import of it. A const defined through itself and an import cycle among literal modules are refused. A
  relative import names one file: its exact name, or exactly one extension candidate; two candidates (`m.ts` and
  `m.tsx`) and a directory import are refused, because Bun's choice there is not one the reader repeats. Every runtime import and every
  export of a literal module is checked, used or not; no side-effect import, namespace import of a relative module
  or re-export with a source.
- **Builders:** `z` (named, renamed or namespace) from `zod/v4` or `@fabrika/app/schema` (the same subset, read alike), its members written with a dot (`z['string']` is
  refused); `defineApp` from `@fabrika/app/contract`, called once as `defineApp(vocabulary, tables, { imports }?)` in a
  const (the kit; `src/app-kit.ts`), whose `app.<builder>(…)` calls are `group`, `contract`, `cron`, `webhook`, `link`
  and `export`, in any module (`app` used as a value is refused); `defineContract` from `@fabrika/app/contract`, called once
  as `defineContract(vocabulary, (c) => ({ … }))`; `attachment` from `@fabrika/app/contract`, called once as
  `attachment({ format, filename, row, maxBytes, maxRows? })` where an output stands or in a const one names (the
  reader builds it with the runtime's `attachmentOutput`, so a method on it is refused as on any non-schema);
  `defineVocabulary` from `@fabrika/app/contract`, called once with
  one object literal (`src/vocabulary.ts`), which reads as its `app`, `dimensions`, `actions` and `roles`, as the runtime
  copies them; `defineTables` from `@fabrika/db/tables` (never `@fabrika/db`, whose root also loads the Bun-only data
  layer the SPA would bundle with the contract), only as `defineTables(vocabulary, columns)({ … })` (the first argument an object with the
  vocabulary's four sections), with `columns` imported from the generated `src/db/schema.generated.ts`; the form that
  names the action union by hand, `defineTables<DB, Action>(columns)`, is refused. The vocabulary reaches
  `readTables`, which derives each table's containment as `defineTables` does and refuses what it refuses; the
  foreign keys it checks a containment column against are the generated column list's, read from source.
- **Functions:** an inline arrow with one parameter and an expression body, only as the second argument of
  `defineContract` and as `procedures` in the options of `c.link(path, { … })`. Its parameter is used only as
  `c.<builder>(…)`: `rpc`, `query`, `mutation`, `link`, `spa`, `health`, `webhook`, `files`, `cron`, `export`.
  In the kit form: `app.contract((c) => ({ … }))`, whose `c` has `rpc(prefix, groups)`, `spa`, `health` and
  `files`; `app.group(options, (r) => ({ … }))` and `procedures` of `app.link(prefix, { … })` and `app.export({ … })`,
  whose parameter has `query` and `mutation`. The handler of `.handle(…)` is no exception: the slice removes it first,
  and a `.handle` the slice keeps (a named function, a builder that takes none) is refused.
- **Declared fields** of a kit site (`sql`, `unscoped`, `connect`, `issues`) are plain literals; `buildArtifact`
  checks what each site may carry.
- **Schemas:** `z.<factory>(…)` then any number of `.<method>(…)`, each called; or a literal const of the module or
  an imported one, then methods (`Status.optional()`), which the reader applies to the schema the const holds and
  refuses on any other value.
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
  - refused by combination, in one chain (a const's chain and the methods applied to it count as one, refused by the reader at the call that adds the check), because the artifact keeps a string's checks unordered: two formats
    (`uuid`, `email`, `url`, `z.iso.*`); `url` with any other string check (it rewrites the value the later checks
    see); `startsWith`, `endsWith` or `includes` with a format. `@fabrika/app`'s `compileContract` refuses the same
    combinations, and also a `.default()` on a discriminated union's discriminator, under any wrapper, and a
    `.default()` whose value its own schema refuses (zod returns a default unchecked), which a chain cannot show.

## The reader beyond the literal subset

The literal rule fixes the forms; the reader also checks what the types check, because Control reads a commit
nobody has type-checked. It refuses with the `contract` rule:

- a mount, procedure, file kind, job or export that is not its builder call (a hand-written
  `{ kind: 'rpc', … }` is refused even where the types accept it), `l.<builder>` other than `query` and `mutation`, a
  mutation in an export;
- a field of the wrong type, a missing required field, an unknown key in the vocabulary, a dimension, a role, an
  access, an import or the CSP, and a builder called with the wrong number of arguments. Unknown builder options are
  recorded in `unknownOptions`, as the kit does, so `buildArtifact` refuses them in the runtime's words: `c.files`
  reads only a file kind, so an old collection's `owner` is refused there as at runtime, and so is a job's `scope`;
- a `z` step on the wrong schema (`z.string().positive()`), an argument of the wrong type or count, and an option
  other than `message` and `error` (a string or `{ message, error }`) plus, where zod takes them, `version` of a
  UUID, `offset`/`local`/`precision` of `z.iso.datetime`, `precision` of `z.iso.time` and `position` of
  `.includes()`. Those options reach zod unchanged, so `describeContract` refuses a non-default one as at runtime.

## Trusted by name

The literal rule and the reader recognise `z`, `defineContract`, `defineVocabulary`, `defineApp`, `attachment` and `defineTables` by
the package they come from.
`trust.ts` refuses, in the checker (`unchecked-import`) and in the reader (`ContractSourceError`), everything that
can make such an import load something else:

- a `paths` (any `tsconfig.json` or `jsconfig.json`, and every file it `extends`) or `package.json` `imports` pattern
  that can match `@fabrika/*`, `zod`, `zod/*` or `bun`, wildcards included (`*`, `@fab*`);
- `baseUrl`, under which Bun resolves a bare `zod/v4` to an application file before `node_modules`;
- an `extends` of a package or of a file outside the application, and a `tsconfig.json` that does not parse;
- a top-level `preload` in `bunfig.toml` under any key spelling (`"preload"` is `preload`), whose plugin can resolve
  any import; a `[test] preload` that is not a checked source file (`./…` outside `fabrika/`, `dist/`,
  `node_modules/`, `tools/` and dot directories), because the platform build runs it; and a `bunfig.toml` outside the
  TOML subset `toml.ts` reads.

Mappings for other specifiers stay; the contract graph imports only relative modules and the trusted packages anyway.
Not covered: the installed packages themselves (a `dependencies` spec, `overrides`, a registry scope), which the
platform build controls.

## The resource budget

`CONTRACT_LIMITS` (`limits.ts`, exported from `@fabrika/check/contract`), each enforced before the next step runs:

| Limit         | Value   | Enforced                                                                                                                    |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| `sourceBytes` | 4 MiB   | UTF-8 bytes of the contract graph, before each module is parsed                                                             |
| `moduleBytes` | 512 KiB | UTF-8 bytes of one module, before it is parsed; `contractReaderInputs` does not parse a larger one either                   |
| `astNodes`    | 400 000 | syntax nodes of each graph (the contract's, the tables'), top-level type declarations left out, after each module is parsed |
| `astDepth`    | 128     | syntax nesting of each module, measured without recursion, before any rule walks it                                         |
| `schemaNodes` | 60 000  | schema nodes with shared schemas expanded: per schema while built, per placement summed                                     |
| `schemaDepth` | 32      | nesting of one schema, while it is built                                                                                    |

A schema value carries its expanded node count, so a const reused at every level (`S1 = { left: S0, right: S0 }`,
…) is refused at the level that crosses the budget, without expanding it.

The reader's memory is its syntax trees, held for the whole read. `parseModule` keeps them small: a node's `loc` is the
start of its line, shared by every node of that line, and `positionOf` adds the node's offset; no comment is attached to
a node. The contract's graph drops each module's top-level type declarations (`withoutTypeDeclarations`), which no
rule of the reader reads.

Control reads in a Worker isolate of 128 MB, so the byte limits bound the parse and `astNodes` bounds the trees the
reader holds. Measured in workerd as the smallest total V8 heap (`--max-heap-size`, 2 MB steps, a fresh isolate per
probe) in which Control's whole read completes, from the commit's files through the serialized snapshot: a contract at
the limits, 4 194 958 bytes in 217 modules of schemas and endpoints with their handlers, 397 125 syntax nodes and
59 513 schema nodes, needs 95 MB, 25 MB of it the isolate before the read; the contract's read and check is the peak.
That input is ASCII; Control holds up to 8 Mi characters of it (`readerTotalChars`), as two-byte strings once a module
has a character outside Latin-1, which is not measured. Control also refuses a contract whose stored snapshot does not
fit its row (`storedSnapshotFits`): the stored form costs each distinct field its name, so many distinct long field
names reach that bound before `schemaNodes`; that contract stores 1 625 988 bytes, over the 1 500 000 bytes it allows.
Not covered: a dense module, such as one literal of 210 000 `0,` elements (420 KB, under every limit) beside 189 000
nodes of ordinary code, needs 123 MB, and the node count comes only after its parse. Only a developer of the
installation's applications can write one, and it restarts the isolate; it leaks nothing. Reading the contract outside
the Worker closes it.

## Documented escapes (D11)

Each has a fixture in `direct-forms.test.ts` that asserts it passes, so that closing one is a visible change:

- test registrations in a helper module that a test file imports (test rules apply to test files by name);
- outside `src/`, `process` reached through a computed member and destructured (`const { env } = globalThis['process']`);
- an alias of `fetch`; a renamed capability type (`Ref as R`); a namespace alias of the test API;
- a hand-written module named and headed as a generated one (`a.gen.ts` opening with `// @generated`) escapes
  `type-assertion`, `any-type`, `suppression-comment` and the architecture's hints; every rule about what it does,
  and its loads, still applies (`generated.test.ts`).

## Invariants

- **NO SUPPRESSION SYNTAX, EVER.** The checker recognises no ignore comment, no allowlist file and no per-rule
  switch. Every escape hatch would be the first thing an agent reaches for when a rule blocks it. A suppression
  comment meant for another tool is itself a finding. `tools/` is not one: moving code there takes it out of the
  application, because nothing the application runs may load it (`tool-import`). Never let a configuration name
  another such directory, nor narrow `tool-import`. Nor is the generated-module convention: it is fixed (a name and a
  header), lifts only the rules about how source is written, and never a rule about what code does; never widen it to
  a rule of the second kind or let a configuration name its files.
- **Every finding names the allowed form.** Over MCP the build log is the agent's only feedback, so a finding
  without a way forward is a dead end. Keep `allowed` concrete.
- **One static resolver.** Rules that need to know what a name denotes ask `ModuleGraph`; do not add a second
  resolution path to a rule, or the rules drift apart on the same source. Likewise every rule that follows a mapped
  specifier asks `mappedTargets(mappings, file, specifier)` for the importing module.
- **The platform runs this checker by version** (`bun x -p @fabrika/check@<version> fabrika-check`, from
  `@fabrika/app/build`'s `contractChecks`: in `@fabrika/provider-zerops`'s generated build, ADR-0043, and in the Cloudflare
  deploy's `check` step), never the application's own copy. The version is the newest
  patch of the minor the application's `bun.lock` pins (`lockedRegistryVersion`), so an older application is checked
  by its own minor's rules (ADR-0062). `CHECKER_VERSION` is read from `package.json`; installations run the git source, so a
  release sets it before tagging (`release:bump`). `package-replacement` is
  what makes the application's frozen install (the Zerops build's and the Cloudflare runner's) the published `@fabrika/*`; it reads the root `.npmrc` and `bun.lock`,
  the only dot file and lockfile the checker reads.
- **A hint never fails the check, and never reaches Control.** It is syntactic and easy to escape (destructured
  `ctx`, a handle passed into a helper); a rule that guards platform integrity is a refusal instead. Every rule id is
  in exactly one of `REFUSAL_RULE_IDS` and `HINT_RULE_IDS`.
- **The layout constants in `layout.ts` are a contract with other work units.** `fabrika/entry.generated.ts`
  (A4 writes it), `db/migrations/` (A9). Change one only together with its producer.
- **The test rules stop mistakes; the data layer and the proxy are the enforcement.** `mock-module`, `skipped-test` (the
  `bunfig.toml` keys included) and `test-without-assertion` keep the application's own suite whole, which the platform
  build runs. A deliberately hostile author can always subvert code that runs in the same process; do not grow these rules
  into a sandbox. fabrika tests its policy enforcement once, in `@fabrika/app`'s
  `policy-enforcement.property.test.ts`; an application carries no test of it.
- **`@babel/parser` is pinned exactly (8.0.7).** It is plain JavaScript and also runs in a Worker, which B1 needs.
  A parser upgrade can move positions and change node shapes; rerun the spike fixture test.
- **The reader evaluates no application code, and normalizes nothing itself.** It calls only zod's own builders on
  literal arguments and copies fields as `@fabrika/app`'s kit does; `compileContract` (`describeContract` +
  `buildArtifact`) does every check and default. A change to the kit's builders (`BUILDER_FIELDS`, a new option) is
  a change to `reader/surface.ts`; `differential.test.ts` fails when they drift.
- **`@fabrika/check/contract` is Worker-safe.** `contract.ts`, `slice.ts`, `reader/*`, `graph.ts`, `ast.ts`, `layout.ts`,
  `finding.ts`, `trust.ts`, `jsonc.ts`, `toml.ts`, `limits.ts`, `inputs.ts`, `version.ts` and `rules/literal.ts` import no
  `node:*`, `bun` or file API. A Worker bundle of the reader measured
  638 KiB, 153 KiB gzip with wrangler 4.72 `--dry-run --minify` (Babel ~71 KiB gzip of it), and reads the notes
  contract in workerd.
- **Read nothing outside the checked set.** `node_modules`, `dist`, dot-directories and `fabrika/assets/` (the SPA files a
  Cloudflare deploy stages, `isSkippedPath`) are skipped, and symbolic
  links are reported, never followed; `unchecked-import` is what keeps code from hiding there.

## Notes

- The SPA rules (`import.meta.env`, `innerHTML`, `eval`) apply to every file, because the
  server has no DOM to lose and Bun's `import.meta.env` is `process.env`.
- `cross-app-fetch` refuses every absolute URL with a static prefix whose origin no site declares in `egress`:
  statically, another application's origin and a third party's look the same. It accepts an origin any site declares,
  not only the site the call is in; the runtime guard on `fetch` checks the site that runs. A template whose first
  label alone is interpolated (`` `https://${tenant}.<domain>/…` ``) is accepted under a declared pattern of that
  domain and port; what the label holds at runtime is the guard's to check.
  Where a cron job declares `egress: 'public'` (ADR-0075) it accepts an http(s) prefix the URL rules of
  `@fabrika/auth-core` admit, or one whose host is not complete yet (`` `https://${host}/` ``), and still refuses
  `http://localhost/` or an IP address: the installation's hosts and resolved addresses are the runtime guard's to judge.
- `cross-app-fetch` and `url-endpoint` wait for the contract: the checker compiles it against `src/db/tables.ts` once
  the contract rules pass. Without a compiling contract every absolute `fetch` stands and no `ctx.url` is checked.
- A setup in `zerops.yaml` without a `run` section is not checked for jobs; every other setup carries them all.
- The checker runs the reader without table policies, so `buildArtifact`'s checks (unknown actions, paths, table
  links) run only where the tables are known: in Control and `compileContract`. The reader reads `src/db/tables.ts`
  (`readTablesSource`); the checker compiles the contract against it for `contract` and the two rules above.
- Not here yet: squawk rules and destructive-migration markers (backlog 98), timers as
  job substitutes (A15), store functions that take bare ids.
