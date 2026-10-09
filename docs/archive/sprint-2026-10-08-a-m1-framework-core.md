> **OUTCOME — shipped 2026-10-09.** Applications are written against a literal contract: `defineContract` and
> `compileContract` (canonical artifact), `implement` and `boot` with in-process authorization and admission, a typed
> client, a test kit that runs proxy-core's real decision, `schemaFromContract` for IAM, and `@fabrika/check`. Every
> work unit had an independent review and one or two fix rounds. Verification: full `bun run test` with Postgres and S3
> at each merge (last: 5479 pass, 38 skip — live Zerops only, 0 fail), `bun run local:reset && bun run local:smoke`
> passed (run `01a11dc3-9c6f-708a-afa7-3e669814a615`). Superseded in the same run: generated gates (A4) — B2 serves
> every contract application behind its endpoint table. Deferred: the examples move to contracts in A17.

# Sprint — A-M1: framework core (2026-10-08)

**Goal.** Applications written against the contract on both clouds, with generated gates, in-process checks and a
checker: A0–A7 of the implementation plan (deleted at close; see git history).

**Theme.** Part A's foundation. Run by the orchestration (deleted at close; see git history).

## Refs re-verified at HEAD (2026-10-08)

Each work unit re-verifies the plan's facts it depends on before coding.

## Work units

The work units are A0–A7 in the plan; their text is not copied here.

| WU | State             | Commits / note         |
| -- | ----------------- | ---------------------- |
| A0 | landed            | `b74a4354`, `3373f2a7` |
| A1 | in review fixes   |                        |
| A2 | queued (after A1) |                        |
| A3 | queued (after A2) |                        |
| A4 | queued (after A3) |                        |
| A5 | queued (after A3) |                        |
| A6 | queued (after A3) |                        |
| A7 | landed            | `f93d8ba8`…`57faff7a`  |

## Out of scope (explicit)

A-M2 and later; part B.

## Decisions

- H2: A0 text approved by the owner. `ContractArtifact` types live in `auth-core`; its zod schema lives where it is
  parsed. zod is a peer dependency of `@fabrika/app`. ADR-0022's "no issuing method" is reworded in A13.
- H4: the parser is `@babel/parser` 8.0.7 (`typescript` + `estree`).
- A7: `@fabrika/check` exposes the `fabrika-check` bin; directly spelled forms are refused, aliased forms are
  accepted D11 escapes with escape fixtures; the supported `z` subset is listed in `packages/check/CLAUDE.md`.

## Sequencing

A1 → A2 → A3 → {A4, A5, A6}; A7 independent.

## Run log

- 2026-10-08: A7 landed after one fix round covering 25 review findings.
- 2026-10-08: A1 landed after one fix round. The gate matcher reads a `:name` segment as one non-empty segment, the
  same rule as `planEndpoint`; a differential test checks gate/table parity. Under a reserved prefix the part-A gates
  are coarser than the table (the app refuses with 404); B2 closes it. An undecodable escape is non-canonical (400).
- 2026-10-08: A1's merge let one Operations test fail (`/%` now 400); fixed in `1acad151`. Merges now go through a
  script that stops on any failing test.
- 2026-10-08: A2 landed after one fix round: builder-owned option fields cannot be overwritten; order-dependent
  string checks, defaulted discriminators and boolean coercion are refused; the artifact is canonical
  (`canonicalArtifactJson` in auth-core); `compileContract` parses its own result. Open for A13: webhook bodies parse
  with a stripping schema. Open for A8b: table policies as data from a browser-safe `@fabrika/db` subpath.
- 2026-10-08: A3 landed after one fix round: the app verifies the token audience against `FABRIKA_IAM_APP_ID`
  (`<app>@<env>`) and refuses to boot when its app part differs from the contract; capabilities resolve to frozen
  copies; every 5xx answers a fixed body; the generated entrypoint scrubs `FABRIKA_*` before importing the app;
  union outputs project through the first accepting branch. `handlers` is a function of `deps`.
- 2026-10-09: A4 landed after one fix round (wildcards and reserved role keys refused at the artifact parser;
  `creates` only for top-level dimensions). B2 then removed `gatesFromContract`: a contract app requires the proxy's
  `X-Fabrika-Endpoint`, so it is always served behind its endpoint table.
- 2026-10-09: A5+A6 landed after one fix round: the kit runs proxy-core's verify service; production code cannot
  import the kit (`test-only-import`); keys go only to the same origin in a browser; the token size limit is shared.
