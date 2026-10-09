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

| File                                                         | What it is                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `fabrika.contract.ts`                                        | Who may call what: dimensions, actions, roles, the `/api` procedures, `attachments`, `purge`.     |
| `src/db/tables.ts`                                           | The table policy of `notes`: its scope, the action of each operation, the writable columns.       |
| `db/migrations/`                                             | Plain SQL of the application's schema, the file collection's table included.                      |
| `src/db/schema.generated.ts`                                 | Written by `fabrika db codegen` from the migrated schema.                                         |
| `src/db/database.ts`, `src/db/stores/`                       | The data layer, `scoped(tables)`, and the store every handler and the job reach rows through.     |
| `src/app.ts`                                                 | `implement(contract, …)`: one handler per procedure, and the `purge` job.                         |
| `src/db/__tests__/`, `src/__tests__/endpoint-access.test.ts` | Written by `fabrika db test-scaffold`; the platform runs them at container start.                 |
| `src/__tests__/notes.test.ts`                                | The author's own tests, through `testKit`: each allowed call has a refused twin.                  |
| `fabrika.config.ts`                                          | The deploy surface: a database, a bucket and the runtime, the compiled contract, its proxy table. |
| `fabrika.cheap.config.ts`                                    | The cheap tier: the bucket and the runtime, on the namespace's shared PostgreSQL.                 |
| `zerops.yaml`                                                | Only the build base. The platform generates the rest of the setup (ADR-0043).                     |

`fabrika/entry.generated.ts` is not committed: the platform build writes it, and so does the local stack.

## How a deploy runs it

The proxy serves the contract's endpoint table and is the only enforcement of who may call what
([ADR-0022](https://github.com/contember/fabrika-platform/blob/main/docs/decisions/0022-the-proxy-is-the-only-enforcement-point.md)).
The data layer scopes every row operation by the capability the endpoint's access form minted. Control reads the
contract, the table policies and the migrations at the commit; a change that widens access on `prod` waits for a person
to approve it in the console.

On Zerops the platform owns the setup. The build installs, runs `bun test`, writes the entrypoint, runs `fabrika-check`
and the type check. The start script runs `fabrika db migrate`, `fabrika db codegen --verify` and
`fabrika db test-isolation`, then the server; the crontab runs `fabrika job run purge`. Every `FABRIKA_*` variable is
the platform's: the database URL from `notesdb`, the storage from `notesfiles`, the IAM issuer and audience, the proxy
secret, the contract digest and the Operations DSN.

Not built yet on Zerops: the IAM membership transport, so this example has no `creates`, members or share links; and
handing the browser its Operations DSN (fabrika-platform backlog 102).

## Running it

```bash
FABRIKA_TEST_POSTGRES_URL=postgres://… bun run test   # bun test --isolate: the author's and the generated tests
bun run typecheck
bunx fabrika-check .
```

Without `FABRIKA_TEST_POSTGRES_URL` every database test skips, and a skip proves nothing. `--isolate` is required
because the generated endpoint access test and `notes.test.ts` both boot the application, and its data layer binds
once per process.

After a change to the contract or the table policies:

```bash
fabrika db new <slug>                                   # a new migration; never edit a committed one
FABRIKA_APP_ID=notes FABRIKA_APP_DATABASE_URL=postgres://… fabrika db migrate
FABRIKA_APP_ID=notes FABRIKA_APP_DATABASE_URL=postgres://… fabrika db codegen
fabrika db test-scaffold
```

In fabrika-platform, `bun run local:smoke` deploys this directory through Control and the Zerops emulator and serves
it from a composed container with the variables a deploy writes (`docs/reference/local-development.md`).

## Updating the standalone repository

The monorepo directory is the source of truth and the mirror's tree must equal it byte for byte. The mirror's history
is curated rather than replayed, so an update is one commit on top of what is there:

```bash
git clone git@github.com:contember/fabrika-example-zerops.git /tmp/fabrika-example-zerops
cd /tmp/fabrika-example-zerops
git fetch /path/to/fabrika-platform main
git read-tree -u --reset FETCH_HEAD:examples/zerops-app
bun /path/to/fabrika-platform/scripts/release.ts example-pin . --tag=<released tag>   # pin the released packages
bun install                                             # refresh bun.lock against them
git commit -m "…" && git push origin main
```

`bun.lock` here pins the packages of the last release that the mirror installed. The example now needs `@fabrika/db`,
`@fabrika/proxy-core` and `@fabrika/platform` of a release that carries the contract framework, so export it only
after that release, with the pins and the lockfile refreshed in the mirror as above. A fresh export must pass
`bun install --frozen-lockfile`, `bun run typecheck` and `bun run test` from its repository root. Do not edit the
mirror directly, and do not use `git subtree split`: it replays the monorepo's history into a public repository.
