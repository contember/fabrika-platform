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

- **The composition is secure by default and runs the REAL enforcement path.** `localPlatformProxyManifest`
  is a CALLER of the installation's own generator, not a second copy of it: it hands
  `resolvePlatformProxyManifest` (`@fabrika/installation-zerops`, imported by relative path because the
  generator is dev-time only) the local hosts, the local scheme and IAM's local port, and gets the same
  three apps a deployed installation is fronted by, with the same gates. Everything else — which apps
  exist, their ids, `CONTROL_PROXY_GATES`, `OPERATIONS_PROXY_GATES` — comes from that one declaration,
  so a gate change cannot reach a deployed proxy and miss this one, or the reverse.
  `src/__tests__/platform-manifest.test.ts` pins exactly which fields this composition is allowed to
  differ in. No synthetic persona exists anywhere — the app SDK has none to select.
  The single dev bypass is IAM's `LOCAL_DEV_LOGIN`, which mints a real session row and is refused at
  use once the flag is off; the browser composition runs with it off. Never widen a local gate to make
  something pass: a refusal here is a refusal in production.
- **`registerLocalApps` stands in for the deploy this composition does not have.** Since
  [ADR-0023](../../docs/decisions/0023-one-session-per-host.md) a session reaches an app's host ONLY
  through a one-time code for a REGISTERED return origin, and locally nothing deploys the console.
  `src/app-registration.ts` therefore makes the same `reconcileSchema` call a deploy makes — same
  endpoints, same admin credential — for `vozka` and `notes`, right after the composition reports
  healthy. Every host then gets its own `__Host-px_session`. This is not a local-only mechanism, and
  there is no local-only branch in IAM or the proxy to support it; an app missing from that list is a
  400 naming its address at sign-in. `src/__tests__/app-registration.test.ts` pins the registered
  origins against the manifest hosts, because a drift between them is invisible until someone logs in.
  `__tests__/proxy-gates.test.ts` (deliberately outside `src/`, so `typecheck` never follows its
  oblaka import) pins the other side: what a deployed Cloudflare proxy Worker actually bakes in.
- **A script needs a `px_` service key, not the provisioning key.** `local:up` provisions one through
  IAM and writes `.state/machine.env`; `mintFromKey` cannot resolve `FABRIKA_IAM_PROVISIONING_KEY`
  (it has no `credentials` row), so the proxy refuses it before control sees the bearer.
- **`prepareLocalStack` must never be a `prepare` script again.** It was one, so it ran inside every
  `bun install` of this workspace — spawning a nested `bun run --filter @fabrika/dashboard build`
  against a `node_modules` the outer install was still writing. That race failed a release and a live
  Zerops platform build (`Cannot find module '@fabrika/auth'`, `ENOENT … @buzola/codegen`), and it hit
  `iam`, `operations` and `proxy`, none of which want a console. `control` names the console build in
  its own `buildCommands`, which is where a service's build belongs. Reach this from `local:up`,
  `local:reset` and `browser:up` only.
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
