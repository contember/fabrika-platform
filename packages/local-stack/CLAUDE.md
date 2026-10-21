# @fabrika/local-stack

The Docker composition behind every root `local:*` and `browser:*` command: both Postgres instances,
SeaweedFS, a Zerops API emulator, and all three planes behind two Caddy proxies. It validates Fabrika
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
bun run local:compat  # Notes at v0.6.0, v0.5.5 and v0.4.8 from npm, deployed and upgraded (ADR-0062); empties the Notes database
bun run local:reset   # down --volumes + wipe .state/ + fresh up
bun run local:down
bun run browser:up    # the separate browser-test stack; browser:reset, browser:down
bun run test:browser  # the opice suites in tests/browser/
```

`bun run local:up` needs Docker with Compose v2 and `cpu-lease` (the console build is CPU-heavy).

## Invariants

- **The composition is secure by default and runs the REAL enforcement path.** `localPlatformProxyManifest`
  is a CALLER of the installation's own generator, not a second copy of it: it hands
  `resolvePlatformProxyManifest` (`@fabrika/platform-artifacts/proxy-manifest`, the private
  dev-time generator package) the local hosts, the local scheme and IAM's local port, and gets the same
  three apps a deployed installation is fronted by, with the same service tables. Everything
  else — which apps exist, their ids, their tables — comes from that one declaration, so a table change
  cannot reach a deployed proxy and miss this one, or the reverse. Control's MCP switch is the digest of the
  console table this manifest publishes, written to `.state/control-table.env` on every prepare.
  `src/__tests__/platform-manifest.test.ts` pins exactly which fields this composition is allowed to
  differ in. No synthetic persona exists anywhere — the app SDK has none to select.
  The single dev bypass is IAM's `LOCAL_DEV_LOGIN`, which mints a real session row and is refused at
  use once the flag is off; the browser composition runs with it off. Never widen a local endpoint table to make
  something pass: a refusal here is a refusal in production.
- **MCP authoring is OFF locally by default.** A managed MCP client is a CIMD document IAM fetches over
  HTTPS, and there is no local one — do not add a fake CIMD server. Setting `FABRIKA_LOCAL_MCP_CLIENTS_JSON`
  before `local:up` turns it on through the installation's own resolver: `prepareLocalStack` rewrites
  `.state/iam-oauth.env` (empty = off) and the platform manifest on every run.
- **`registerLocalApps` stands in for the deploy this composition does not have.** Since
  [ADR-0023](../../docs/decisions/0023-one-session-per-host.md) a session reaches an app's host ONLY
  through a one-time code for a REGISTERED return origin, and locally nothing deploys the console.
  `src/app-registration.ts` therefore makes the same `reconcileSchema` call a deploy makes — same
  endpoints, same admin credential — for `vozka` and `notes`, right after the composition reports
  healthy. Every host then gets its own `__Host-px_session`. This is not a local-only mechanism, and
  there is no local-only branch in IAM or the proxy to support it; an app missing from that list is a
  400 naming its address at sign-in. `src/__tests__/app-registration.test.ts` pins the registered
  origins against the manifest hosts, because a drift between them is invisible until someone logs in.
  `__tests__/proxy-tables.test.ts` (deliberately outside `src/`, so `typecheck` never follows its
  oblaka import) pins the other side: what a deployed Cloudflare proxy Worker actually bakes in.
- **The composed Notes container holds its workloads' keys before it starts.** It refuses to start without a key per
  job and webhook (ADR-0022 "Principal kinds"), and nothing deploys it. So `upLocalComposition` (`src/up.ts`) starts
  the platform first, registers the apps, and `src/workload-keys.ts` makes Control's own `workloads.issueKey` call into
  `.state/notes-workloads.env`, keeping a key while IAM still exchanges it; only then does Notes start. `local:smoke`
  checks the keys its deploy wrote on the emulator and hands those to the container: each issuance revokes the
  workload's other keys, so the container would otherwise hold a revoked one.
- **All mail is captured in `.state/mail/`.** Control and the applications name the `directory` provider
  (`FABRIKA_EMAIL_PROVIDER=directory`, the `x-local-mail` set Control holds in `compose.yaml` and a deploy hands only an
  application whose job declares `mailer: 'installation'`), because an application runs the generated production
  entrypoint, which takes nothing but its environment. IAM holds the same set beside `FABRIKA_CONTROL_URL`, so it sends
  through Control's mail relay as on Zerops, and Control's relay dispatcher writes the message there a poll later. The
  local IAM and Control accept that provider only because `src/iam-server.ts` and `src/control-server.ts` register
  `LOCAL_EMAIL_PROVIDERS`, and an application only under a loopback issuer (`@fabrika/app/bun`'s local providers);
  anywhere else boot refuses it as an unknown provider. `prepareLocalStack` creates the directory as the host's user, so
  a reset can remove what the root container wrote. A suite reads a person's newest message with `waitForMail` (`src/mail-capture.ts`), an application's
  by its transport key; the files hold one-time links, so nothing prints one.
- **The composed Notes container holds IAM's membership transport before it starts.** Notes manages workspace members,
  so a deploy writes `FABRIKA_IAM_RPC_URL` and `FABRIKA_IAM_RPC_KEY`, and `boot` refuses to start without them. `up`
  makes Control's own `membershipKeys.issue` call into `.state/notes-membership.env` (`src/membership-key.ts`), and
  `followNotesDeploy` and `local:smoke` hand the container the pair the deploy wrote instead. `up` keeps a stored key
  IAM still accepts: an issuance deletes the environment's other keys, so a fresh one would revoke the key Control records.
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
- **Notes is the example, deployed and served as a contract application.** The application source fixture is the
  complete example as its repository holds it, plus the generated entrypoint and a `bun.lock` that resolves its
  `@fabrika/*` pins at the source version the container runs (`applicationFixtureSource`), pinned by
  tree in `fixtures/source/manifest.json`, so Control approves the contract the composed container serves. An edit of
  the example moves the pin: run `bun run fixtures:pin` here. `deployable.test.ts` runs the build's checker and, on
  Postgres, the init commands' steps over the archive itself. The container runs
  the platform's init-command steps and the generated entrypoint with the variables `prepare.ts` writes. Never give it
  a variable the platform would not write: the apps proxy serves its endpoint table.
- **The composition follows a deploy only when told to (`src/notes-follow.ts`).** The emulator runs no code, so
  `followNotesDeploy` makes the composed Notes container and the apps proxy serve what the emulator's active Notes
  version deployed: the endpoint table Control published on the namespace proxy (never one computed here), the contract
  digest and workload keys the deploy wrote, and the source of that commit — the workspace example, or the agent change
  fixture copied to `.state/notes-source/` (`FABRIKA_LOCAL_NOTES_ROOT`). Every `up` returns it to the example. The
  `notes-agent-change` browser seed (`src/notes-agent-change.ts`) deploys and approves the pinned commit, follows it,
  and parks the agent change commit (`fixtures/source/notes-agent-change.patch`, pinned as `agentChange`) for its scenario.
- **The Operations reporting witness is the Notes example's SPA.** `prepare.ts` builds it (`dist/web`, `buildNotesSpa`) on every
  prepare, and `followNotesDeploy` builds the staged agent change's before it serves it; its `FabrikaProvider`
  reads the DSN, the release and the environment from the framework's `/__fabrika-config.json`. The browser stack recreates `notes` with
  a seeded source's DSN (`FABRIKA_BROWSER_OPERATIONS_DSN`, `compose.browser.yaml`).
- **`.state/` holds generated local credentials and is disposable**, but only `local:reset` may
  remove it — it wipes the `fabrika-local` volumes in the same step. Deleting one without the other
  leaves services holding credentials the databases no longer accept.
- **Hostnames are load-bearing, not cosmetic.** Services address each other as
  `*.fabrika.localhost` on named networks (`platform`, `apps-prod`) and the smoke test asserts that
  an app container CANNOT reach the private control or Operations networks. Do not flatten the
  networks or add a convenience port publish to work around a connection failure.
- **The Zerops emulator is a test double for the API, not for the platform.** It exists so a deploy
  can be driven end-to-end without an account; a behavior it fakes is not evidence about Zerops. See
  `docs/reference/zerops-platform.md` for what is actually verified. Its behaviour is pinned by the
  shared `platform-facts` table (`packages/provider-zerops/src/__tests__/platform-facts.ts`), which
  the opt-in live suite runs against a real account — change a fact there, not here.
- **The GitHub double is a test double for GitHub's API, not for GitHub.** Control reaches it only
  through the `sourceSeams` that `src/control-server.ts` passes to `createRuntime` — a composition
  input. Never give Control an environment variable or config field that moves its GitHub origins to
  make this work: ADR-0029 fixes them, and control's `fixed-origins.test.ts` asserts it. The double
  verifies every App JWT against that fixture App's own public key; keep it refusing what GitHub refuses.
- **`local:compat` deploys released code, not the workspace's.** A release fixture is the example as its tag holds it,
  recorded in `fixtures/source/releases/` with the `bun.lock` npm resolves for it (`bun run fixtures:release <tag>`,
  then `fixtures:pin`), because a CI checkout holds no tags. `followNotesDeploy` stages such a commit as its platform
  build does: `bun install --frozen-lockfile` from npm, the entrypoint its own framework writes, its SPA; the container
  runs its own `./node_modules/.bin/fabrika`, as the generated init commands do. Never point a release fixture at a
  workspace package: the suite exists to run what an operator's application runs. Each release starts from an empty
  Notes database (`dropApplicationDatabase`), and the suite ages files past the pending grace before the sweep, so
  only a reference keeps one.
- **`local:smoke` is disruptive by design** — it hard-kills control mid-pipeline to prove that the
  maintenance cron (`control/src/zerops/cron.ts`, the production crontab command) reconciles the run once
  the dead holder's deploy lease expires, and exactly-once counting. Do not soften a step to make it pass; a failure there is
  a real finding.
