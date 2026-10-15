# Example app — a contract application on Zerops

A small notes application, deployed by fabrika **to Zerops**. It is the template an agent starts from, in the
builder and over MCP: every file here is one an author writes or a command generates, and nothing in it is a stub.
The rules an agent follows are in [`AGENTS.md`](./AGENTS.md), rendered from the `fabrika-app` skill of `@fabrika/app`.
Do not edit it here; it is regenerated from the skill.

This directory is both a fabrika-platform workspace member and the complete root of the standalone
[`contember/fabrika-example-zerops`](https://github.com/contember/fabrika-example-zerops) repository. Zerops requires
`zerops.yaml` at the root of the repository it builds, so the standalone repository contains this directory's files
directly.

## What is where

| File                                                         | What it is                                                                                         |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`                                          | The authorization vocabulary: dimensions, actions, roles.                                          |
| `src/db/tables.ts`                                           | The table policy of `notes`: its scope, the action of each operation, the writable columns.        |
| `src/app-kit.ts`                                             | `defineApp(vocabulary, tables)`: the kit every endpoint is built with.                             |
| `src/schemas.ts`                                             | The inputs, outputs and limits the shell and the SPA share.                                        |
| `src/notes/endpoints.ts`                                     | The notes slice: each endpoint with its `.handle(…)`, and the `purge` job.                         |
| `src/guests/endpoints.ts`                                    | Staff invite a guest, a person from outside the organization, into a workspace by e-mail.          |
| `fabrika.contract.ts`                                        | Who may call what: the `/api` and `/people` mounts, the SPA, `attachments`, `purge`, the health.   |
| `src/app.ts`                                                 | `serve(contract, { database: scoped(tables) })`, which the generated entrypoint boots.             |
| `db/migrations/`                                             | Plain SQL of the application's schema, the file collection's table included.                       |
| `src/db/schema.generated.ts`                                 | Written by `fabrika db codegen` from the migrated schema.                                          |
| `src/db/__tests__/`, `src/__tests__/endpoint-access.test.ts` | Written by `fabrika db test-scaffold`; the platform runs them at container start. Never edited.    |
| `src/__tests__/endpoint-access.fixtures.ts`                  | The seed the generated tests need: only a note in the trash is restored.                           |
| `src/__tests__/notes.test.ts`                                | The author's own tests, through `testKit`: each allowed call has a refused twin; the job runs too. |
| `web/`, `build-web.ts`                                       | The SPA, its error reporting, and its build through `@fabrika/check/bun-plugin` (no handlers).     |
| `fabrika.config.ts`                                          | The deploy surface: a database, a bucket and the runtime, the compiled contract, its proxy table.  |
| `fabrika.cheap.config.ts`                                    | The cheap tier: the bucket and the runtime, on the namespace's shared PostgreSQL.                  |
| `zerops.yaml`                                                | The build base and the SPA build. The platform generates the rest of the setup (ADR-0043).         |

`fabrika/entry.generated.ts` and `dist/` are not committed: the platform build writes them, and the local stack writes
the entrypoint.

## How a deploy runs it

The proxy serves the contract's endpoint table and is the only enforcement of who may call what
([ADR-0022](https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)).
The data layer scopes every row operation by the capability the endpoint's access form minted. Control reads the
contract, the table policies and the migrations at the commit; a change that widens access on `prod` waits for a person
to approve it in the console.

On Zerops the platform owns the setup. The build runs the SPA build (`bun run build:web`), then installs, runs
`bun test`, writes the entrypoint, runs `fabrika-check` and the type check. The start script runs `fabrika db migrate`, `fabrika db codegen --verify` and
`fabrika db test-isolation`, then the server; the crontab runs `fabrika job run purge`. Every `FABRIKA_*` variable is
the platform's: the database URL from `notesdb`, the storage from `notesfiles`, the IAM issuer and audience, the proxy
secret, the contract digest and the Operations DSN.

The SPA reports its uncaught errors to Operations without code of its own: `FabrikaProvider` reads the DSN, the
release and the environment from the framework's `/__fabrika-config.json`. The build writes each script's source map
beside it; the platform build uploads the maps to Operations, and the mount never serves them. Because `guests.invite` manages the members of a
workspace, the platform also gives the process IAM's membership transport (`FABRIKA_IAM_RPC_URL`, `FABRIKA_IAM_RPC_KEY`),
and IAM sends the invitation; `guest` is the one role declared `external`, and `staff` may assign it in any workspace.

## Running it

```bash
FABRIKA_TEST_POSTGRES_URL=postgres://… bun run test   # bun test --isolate: the author's and the generated tests
bun run typecheck
bunx fabrika-check .
```

Without `FABRIKA_TEST_POSTGRES_URL` every database test skips, and a skip proves nothing. `bun run build:web` writes
the SPA to `dist/web`. `--isolate` is required
because the generated endpoint access test and `notes.test.ts` both boot the application, and its data layer binds
once per process.

After a change to the contract or the table policies:

```bash
fabrika db new <slug>                                   # a new migration; never edit a committed one
FABRIKA_APP_ID=notes FABRIKA_APP_DATABASE_URL=postgres://… fabrika db migrate
FABRIKA_APP_ID=notes FABRIKA_APP_DATABASE_URL=postgres://… fabrika db codegen
fabrika db test-scaffold                                # a precondition's state goes to seeds in endpoint-access.fixtures.ts
```

In fabrika-platform, `bun run local:smoke` deploys this directory through Control and the Zerops emulator and serves
it from a composed container with the variables a deploy writes (`docs/reference/local-development.md`).

## Updating the standalone repository

The monorepo directory is the source of truth and the mirror's tree must equal it at the release tag byte for byte,
except for the `@fabrika/*` pins and `bun.lock`. The mirror's history is curated rather than replayed, so an update is
one commit on top of what is there. The `example-mirror` job of fabrika-platform's release workflow runs these steps
after every release
([`release-process.md`](https://github.com/contember/fabrika-platform/blob/main/docs/reference/release-process.md#pinning-the-standalone-example)).
By hand, after the release is on npm:

```bash
git clone git@github.com:contember/fabrika-example-zerops.git /tmp/fabrika-example-zerops
cd /tmp/fabrika-example-zerops
git fetch /path/to/fabrika-platform <released tag>
git read-tree -u --reset FETCH_HEAD:examples/zerops-app
bun /path/to/fabrika-platform/scripts/release.ts example-pin . --tag=<released tag>   # pin exactly the released packages
bun install                                             # refresh bun.lock against them
git add -A . && git commit -m "chore: sync with fabrika-platform <released tag>" && git push origin main
```

`example-pin` pins every `@fabrika/*` package to exactly the released version, so the example installs the release
that an installation of the same tag runs. A fresh export must pass `bun install --frozen-lockfile`,
`bun run typecheck`, `bunx fabrika-check .` and `bun run test` from its repository root. Do not edit the mirror
directly, and do not use `git subtree split`: it replays the monorepo's history into a public repository.
