# @fabrika/local-stack

The Docker composition behind every root `local:*` and `browser:*` command: both Postgres instances,
MinIO, a Zerops API emulator, and all three planes behind two Caddy proxies. It validates Fabrika
behavior and network boundaries before a credentialed Zerops deploy — it does NOT validate Zerops
infrastructure behavior. Assumes the root CLAUDE.md.

Full endpoint list and the smoke-test walkthrough:
[`docs/reference/local-development.md`](../../docs/reference/local-development.md).

## Commands

Run these from the repository ROOT, not from this package:

```bash
bun run local:up      # generate credentials, build the console, start, migrate, wait for health
bun run local:status  # docker compose ps
bun run local:smoke   # intentionally disruptive end-to-end (kills control mid-deploy, etc.)
bun run local:reset   # down --volumes + wipe .state/ + fresh up
bun run local:down
bun run browser:up    # the separate browser-test stack; browser:reset, browser:down
bun run test:browser  # the opice suites in tests/browser/
```

`bun run local:up` needs Docker with Compose v2 and `cpu-lease` (the console build is CPU-heavy).

## Invariants

- **The composition is secure by default and runs the REAL enforcement path.** The platform manifest
  fronts control and Operations with the same gates their `fabrika.config.ts` declares, and no
  synthetic persona exists anywhere — the app SDK no longer has one to select. The single dev bypass
  is IAM's `LOCAL_DEV_LOGIN`, which mints a real session row and is refused at use once the flag is
  off; the browser composition runs with it off. The gate sets in `src/prepare.ts` are copies —
  the production ones cannot be imported without dragging oblaka's raw TypeScript into this package's
  strict program — and `__tests__/proxy-gates.test.ts` (deliberately outside `src/`, so `typecheck`
  never follows that import) fails if a copy drifts. Never widen a local gate to make something pass:
  a refusal here is a refusal in production.
- **The session reaches the console as a cookie on the shared `fabrika.localhost` parent.** Every host
  is a `*.fabrika.localhost` name on one proxy, which is the case ADR-0021 keeps the shared cookie for.
  The one-time-code handoff a Zerops installation uses additionally needs the console registered in IAM
  as an app with return origins, which only a deploy performs; local coverage of that path is still
  missing.
- **A script needs a `px_` service key, not the provisioning key.** `local:up` provisions one through
  IAM and writes `.state/machine.env`; `mintFromKey` cannot resolve `FABRIKA_IAM_PROVISIONING_KEY`
  (it has no `credentials` row), so the proxy refuses it before control sees the bearer.
- **`.state/` holds generated local credentials and is disposable**, but only `local:reset` may
  remove it — it wipes the `fabrika-local` volumes in the same step. Deleting one without the other
  leaves services holding credentials the databases no longer accept.
- **Hostnames are load-bearing, not cosmetic.** Services address each other as
  `*.fabrika.localhost` on named networks (`platform`, `apps-prod`) and the smoke test asserts that
  an app container CANNOT reach the private control or Operations networks. Do not flatten the
  networks or add a convenience port publish to work around a connection failure.
- **The Zerops emulator is a test double for the API, not for the platform.** It exists so a deploy
  can be driven end-to-end without an account; a behavior it fakes is not evidence about Zerops. See
  `docs/reference/zerops-platform.md` for what is actually verified.
- **`local:smoke` is disruptive by design** — it hard-kills control mid-pipeline to prove startup
  reconciliation and exactly-once counting. Do not soften a step to make it pass; a failure there is
  a real finding.
