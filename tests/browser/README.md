# Operations browser tests

These Opice scenarios drive the built unified console and the Zerops notes
example through the real local composition. They use PostgreSQL, MinIO, IAM,
Control, Operations, both auth proxies, and the same-origin Operations gateway.

## Run

Install dependencies and Chromium once:

```bash
bun install --frozen-lockfile
bunx playwright install chromium
```

Run a tier from a clean stack:

```bash
bun run test:browser                         # critical
bun run test:browser -- --tier standard     # critical + standard
bun run test:browser -- --tier extended     # all scenarios
```

`test:browser` resets the browser composition, creates fresh IAM sessions and
scenario fixtures, forces Opice to discard cached sessions, runs the selected
tier, and removes the composition and volumes in `finally`. Reporting to the
endpoint in `opice.config.json` is best-effort. The executable test result is
authoritative when no reporting service is running locally.

For authoring or a focused diagnostic, keep one prepared stack running:

```bash
bun run browser:reset
OPICE_AUTH_REFRESH=1 bun test --path-ignore-patterns=__opice-no-ignore__ tests/browser/three-plane-navigation.test.ts
bun run browser:down -- --volumes
```

Do not run `browser:reset` while another scenario uses the shared stack. A reset
invalidates every IAM session. Always use `OPICE_AUTH_REFRESH=1` after a reset.

## Fixtures and isolation

- `admin` can use the unified console and both Operations sources.
- `operations-notes` is scoped to the `browser-notes` application and can see
  only `Browser Notes / test`.
- `anonymous` has no `px_session` cookie.
- Mutating scenarios create uniquely marked issues. They must not assert global
  table counts or rely on scenario order.
- `Hidden sibling / secret` is the negative access-control witness. Never expose
  its identifiers, release, health data, DSN, or alert target in output.

Sessions, public ingest configuration, local databases, reports, screenshots,
and videos stay in ignored local state. Test code must never print credentials
or secret values.

## Failures

Opice can write an offline HTML report with `--report=<file>` and browser video
with `--video=<directory>`. These paths are ignored by Git. Preserve a failing
artifact until diagnosis is complete, then remove it with the browser stack.

The outage scenario owns its Operations stop/start cycle. Its cleanup must
restart Operations and wait for health even when an assertion fails. No other
scenario may stop a shared service.

See [invariants.md](./invariants.md) for acceptance properties and
[legacy-poplach-inventory.md](./legacy-poplach-inventory.md) for the source-suite
mapping.
