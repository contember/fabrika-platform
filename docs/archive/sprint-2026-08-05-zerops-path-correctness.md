# Sprint — Zerops path correctness (2026-08-05)

## OUTCOME — closed 2026-08-06, 4 of 5 units shipped

| Unit | Commit    | What shipped                                                                             |
| ---- | --------- | ---------------------------------------------------------------------------------------- |
| plan | `ad17de7` | the plan                                                                                 |
| WU-1 | `f69bccd` | env write without a pre-read; `GET /service-stack/{id}/env` + `PUT /user-data/{id}`      |
| WU-2 | `c559042` | four conformance corrections settled on the account, not the docs (items 39, 42, 43, 45) |
| WU-3 | `bf33bd5` | `ensureSubdomainAccess` — establish the `.zerops.app` entry point or refuse to be ready  |
| WU-4 | `bd59bc7` | live installation to HEAD; two browser-only defects in the sign-in path fixed            |

**Verification at close.** `bun test` 1912 pass / 9 skip / 0 fail against a real Postgres (only the
S3 suites skip); `typecheck`, `lint`, `format:check` clean. Live: an anonymous `GET /api/*` on
`fabrika-test` is refused by Caddy with a 302 to the login bounce, and a real browser completes
sign-in and reads an authorized route.

**WU-5 did not ship, and its premise changed.** It was scoped as "give the Zerops deploy path a
private git source", with fabrika's own installation among the things that needed one. While it was
being sequenced, the boundary it assumed was settled the other way:
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) — the
operator installs the platform, fabrika deploys only apps. That removes fabrika's own code from the
problem entirely (the namespace proxy now builds from a pinned tag of the public repository) and
rejects the credentialed-clone-URL half outright. What remains is one API call, re-scoped into
the later [application deploy sprint](sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md), and it is blocked on a human:
linking a GitHub account to Zerops is an interactive OAuth flow. The install paths ADR-0025 commits
to are filed as [`61`](../backlog/61-make-platform-deploy-an-unattended-command.md),
[`62`](../backlog/62-generate-the-operators-sidecar-install-repository.md) and
[`63`](../backlog/63-a-one-click-install-from-the-public-repository.md).

**Deleted on close:** backlog items 39, 40, 41, 42, 43, 45 — all six settled live, with what they
established recorded in [`reference/zerops-platform.md`](../reference/zerops-platform.md).
**Filed during the run:** 58, 59, 60.

**Goal.** Make the live Zerops installation match HEAD and fix what the account proves is wrong, so
the Zerops path is a supported target rather than a demonstrated one.

**Theme.** The 2026-08-03 bring-up got the light tier onto a real account and stopped there, filing
what it could not finish. Two days later the installation has drifted from HEAD, one of its
mechanisms is provably broken on every call, and four conformance corrections have never been
exercised. This sprint is bounded by what the account can settle: everything here is verifiable
against `fabrika-test`, and anything that needs a second project or a paid tier is out.

## Account facts, re-verified live (2026-08-05)

`zz auth status` — `matejka@contember.com`, org Contember (`oBz9URmRRI2IejbrhfuKQQ`), role OWNER,
region `prg1`. Project `fabrika-test` (`0niMIbRAR4SR6qs8soYL8A`), `ACTIVE`, `LIGHT`.

Live services: `iam`, `control`, `operations`, `proxy`, `notesapi` (all `ACTIVE`), `db`
(`postgresql:single@18`), `storage` (`object-storage`), `core` (`core:single@2`), plus five stopped
build runtimes.

- ✔ **Item 41 reproduces in one command.** `zz env list <service>` → `Service stack not found`, on
  ACTIVE services, by name and by id. `zz env show` works — a different endpoint. This is exactly
  the `GET /service-stack/{id}/user-data` → `400 serviceStackNotFound` the item recorded, still
  true on services that have deployed successfully many times since.
- ⚠ **The live proxy manifest is stale and disagrees with HEAD about the control plane.** It gates
  `vozka` as a single `{ path: '/*', kind: 'public' }`; `CONTROL_PROXY_GATES`
  (`packages/control/fabrika.gates.ts`) declares fifteen rules, `human`/`service` throughout, with
  `{ path: '/*', kind: 'human' }` as the terminal rule. Manifest `lastUpdate` is
  `2026-08-04T13:50:15Z` — before the auth-hardening sprint landed.
  - Not an open door **today**: an anonymous `GET /api/namespaces` returns `401 no_session` from the
    application. But that is the application enforcing, which ADR-0022 says it must not do and which
    the auth-hardening sprint removed from the SDK. The exposure is the gap itself.
  - It also means **the console cannot sign in on Zerops at all**: a `public` gate mints no token,
    so there is no path from the login bounce to an authorized request.
- ✔ **Every environment variable on every live service is already canonical `FABRIKA_*`** (or an
  intentionally unprefixed internal name — `HUMAN_EMAILS`, `IAM_BOOTSTRAP_ADMINS`, `ISSUER`,
  `ENVIRONMENT`, `OPERATIONS_SYNC_KEY`, `NOTES_DATABASE_URL`). Yesterday's ADR-0024 sweep did not
  break this installation, and this is a stronger witness for it than `local:smoke`.
- ✔ The proxy publishes six `zerops.app` subdomains, one per listener; `/` on the 8080 listener
  answers 404 from the proxy itself, which is correct for a host the manifest does not name.

## Safety rules for this sprint — binding on every unit

- **The token is account-wide admin, and the account holds other people's projects.** `respekt`
  (`SERIOUS`), `zerops-console`, `mkl-test` are NOT ours to touch. Every write names
  `--project fabrika-test` explicitly. Never run a command whose blast radius is the organization.
- **Never print a variable's `content`.** `zz env show --json` returns plaintext for `SECRET`
  variables, including ones marked `sensitive: true`. Read keys, not values. If a value is genuinely
  needed, use it without echoing it.
- Destructive service operations (`delete`, `stop` on an ACTIVE service) need a human. Ask.

## Work units

### WU-1 — write a service variable without reading first (effort M) · item 41

- **Problem.** `putServiceEnv` lists a service's variables before writing one, and that list call
  never succeeds — verified again today. So nothing in `packages/` can write a service variable, and
  ADR-0004's bring-up order cannot complete as written.
- **Verify first.** Reproduce all three results the item records: the `GET` failing on a healthy
  service, the `POST` working, and the `POST` on an existing key answering `userDataDuplicateKey`
  rather than replacing. Find what the update path actually is — a distinct endpoint, or
  delete-then-create.
- **Scope.** Make the write path work without a pre-read, and make an update of an existing key
  work. If the only correct sequence is destructive (delete then create), say so explicitly and
  handle the window.
- **Acceptance / witness.** A variable is created and then updated on a live `fabrika-test` service
  through `packages/`, not through `zz`, and read back with the new value.
- **Touch points.** `packages/provider-zerops/src/api.ts`, `control.ts`, `docs/reference/zerops-platform.md`.

### WU-2 — four conformance corrections the account can settle (effort M) · items 39, 42, 43, 45

- **Problem.** Each is a divergence from upstream semantics that schema validation and the dry-run
  driver both pass over. 39: `override: true` written on every service including managed ones, with
  an idempotency claim built on it. 42: two `postgresql:ha@18` with no `profile`, defaulting to
  `oltp-production`. 43: `run.healthCheck` everywhere, `deploy.readinessCheck` nowhere, no timeouts.
  45: `${host_connectionString}` carries no database path and no TLS mode.
- **Verify first.** Settle 39 against the account before changing code — apply a document twice and
  observe what happens to a managed service and to a runtime one. The item's whole question is
  whether upstream's "replace, runtime-only" description is accurate.
- **Scope.** Fix each against what the account demonstrates, not against what upstream documents.
  Where the two disagree, the account wins and `docs/reference/zerops-platform.md` records it.
- **Acceptance / witness.** Per item, a live observation in the reference doc. For 42, the applied
  profile read back off a service. For 43, a deploy that is actually gated. For 45, a connection
  that names its database and TLS mode.
- **Touch points.** `packages/installation-zerops/zerops/{topology.ts,setups.ts,compile.ts,manifest.ts}`.

### WU-3 — a public entry point an import document can establish (effort M) · item 40

- **Problem.** `enableSubdomainAccess: true` does not take effect on a service that has never been
  deployed, so the `zerops-subdomain` path provisions a project with no public entry and reports
  success. We are staying on `.zerops.app` (decided), which makes this the ONLY public access path
  rather than a throwaway convenience.
- **Verify first.** Establish the real sequence on the account: import → deploy → enable, or
  something else. The live proxy has six subdomains, so it works when driven by hand; find what the
  hand does that the document does not.
- **Scope.** Make `zerops-subdomain` provisioning either establish the entry point or fail loudly.
  A path that reports success with no public entry is the defect.
- **Acceptance / witness.** A subdomain-access provision on `fabrika-test` produces a reachable
  public entry point, proven by an HTTP response, or refuses.
- **Touch points.** `packages/installation-zerops/zerops/topology.ts`, the provisioning driver.

### WU-4 — bring the live installation to HEAD (effort L) · item 05, live half

- **Problem.** The deployed manifest predates the auth-hardening sprint: the control plane is gated
  `/*` public, so the console cannot sign in and the only thing refusing an anonymous request is the
  application, which ADR-0022 forbids and which the SDK no longer does.
- **Verify first.** Confirm the drift list before deploying — diff every app's live gate list
  against its `fabrika.gates.ts` / `gates.ts` at HEAD, and check what else the manifest generator
  now emits that the live one lacks.
- **Scope.** Regenerate and deploy. Then prove the thing the bring-up sprint deferred: **a browser
  signs in to the console on Zerops and reaches an authorized route.** This is where the one-time
  handoff, `__Host-` cookies over a real TLS-terminating balancer, and the return-origin registry
  meet a real browser for the first time.
- **Acceptance / witness.** An anonymous `/api/*` request is refused **by the proxy** (302 to login,
  not a 401 from the app); a real browser completes sign-in and reads an authorized route. Use the
  `agent-browser` skill.
- **Touch points.** the deployed manifest, `packages/installation-zerops/`, `docs/reference/zerops-platform.md`.

### WU-5 — a private git source for the Zerops deploy path (effort L) · item 47

- **Problem.** fabrika's GitHub App never reaches the Zerops path. `triggerPipeline` can only name a
  public URL, so a private repository cannot deploy to Zerops — which blocks every deploy the
  control plane triggers itself.
- **Verify first.** Establish what the Zerops pipeline accepts for an authenticated source before
  designing: a token in the URL, a deploy key, an upload instead of a clone.
- **Scope.** Give the Zerops driver a source the platform can clone for a private repository.
- **Acceptance / witness.** A control-plane-triggered deploy of a private repository succeeds on
  `fabrika-test`.
- **Touch points.** `packages/provider-zerops/src/api.ts`, `packages/control/src/repo-source.ts`.

## Out of scope (explicit)

- **Custom domains** — decided: we stay on `.zerops.app`. That is what makes WU-3 load-bearing.
- **The production two-project topology** (items 09, 10) — needs a second project and a paid tier,
  and 10's question (how the `app` secret scope is represented across separate projects) cannot be
  answered without one. Both stay filed.
- **Everything non-Zerops**: 11, 22, 25, 26, 34, 36, 37, 38, 46, 54, 56, 57. Note 56 —
  `release:validate` is red — gates publishing, not this work.

## Decisions

- **The account is the authority, upstream documentation is a hypothesis.** Several facts in
  `docs/reference/zerops-platform.md` already contradict published docs. Where a unit finds another,
  it records the observation and the command that produced it.
- **`fabrika-test` may be written to; nothing else in the organization may.** The bring-up already
  deploys there, and the user confirmed it. That authorization does not extend one project further.

## Sequencing

| Wave | Units       | Why                                                                                       |
| ---- | ----------- | ----------------------------------------------------------------------------------------- |
| 1    | WU-1 ‖ WU-2 | WU-1 unblocks env writes; WU-2 is topology/compiler and touches no runtime state.         |
| 2    | WU-3        | Needs WU-1's write path to provision anything.                                            |
| 3    | WU-4        | Deploys the result of 1–3; the browser proof comes last because it needs all of it.       |
| 4    | WU-5        | Independent of the rest, largest unknown, so it runs when the account is otherwise quiet. |

One unit at a time may hold the account. Two units may not deploy concurrently to `fabrika-test`.

## Run log

<!-- Append as you work: discoveries, deviations, blockers. -->

### 2026-08-05 — WU-1 done

All three recorded results still hold on `fabrika-test`: the `user-data` list is 400
`serviceStackNotFound` on every service tried (`notesapi`, `iam`, `proxy`, `db`, with and without
query params); `POST` works; `POST` on an existing key is 400 `userDataDuplicateKey` and writes
nothing. The update path is **`PUT /user-data/{id}` with `key` AND `content`** — it replaces in
place, same record id, so **nothing destructive is needed**.

**Deviation from item 41's proposed approach.** The item said to thread a `clientId` into the API
client and resolve the conflict through `POST /user-data/search`. Not needed:
**`GET /service-stack/{id}/env`** returns the same user-data record ids, is in the published
OpenAPI document (the search endpoint is not), works on every service including a stopped build
runtime, and is keyed by the service alone. `ZeropsApiOptions` is unchanged. Item 41's "Approach"
section is superseded on that point — delete it with the sprint rather than implementing it.

New: `ZeropsApiError` carries `status` + the platform `code`, so `redactDetail` can keep dropping
the server's prose (it can quote a rejected secret) while the branch on `userDataDuplicateKey`
still works. `listServiceEnv` now reads `/env`, which also un-breaks `secrets.delete` and
`ensureProxyConfiguration`. The Zerops emulator now answers 400 on the list endpoint and rejects a
duplicate create, so the double no longer contradicts the platform.

Live witness through `packages/`: `FABRIKA_WU1_PROBE` on `notesapi` created (`wu1-created`),
updated to `wu1-updated` under the same record id `jy8BF5lRSo619b4OEfgvzQ`, read back, deleted.
Confirmed absent afterwards. Facts + commands → `docs/reference/zerops-platform.md`.

Out of scope, found while probing: a key declared in a service's own `zerops.yaml`
(`run.envVariables`, `type: ENV`) conflicts on create yet never appears in `/env`, so it cannot be
written through the env API at all — `putServiceEnv` now refuses it explicitly.

### 2026-08-05 — WU-2 done (items 39, 42, 43, 45)

All four settled live on throwaway services created and deleted inside `fabrika-test` (`wu2db`,
`wu2st`, `wu2app`, `wu2ha`). No platform service was touched; the project is as it was found. Facts +
commands → `docs/reference/zerops-platform.md`.

**39 — the answer inverts the item.** `override: true` is neither an update nor a replace: an existing
service is left exactly as it is, and a changed `profile`/`maxContainers`/`objectStorageSize` in the
document is silently ignored. Without it the platform answers `400 serviceStackNameUnavailable` and
rejects the WHOLE import — and it does so on a managed `postgresql` service, which upstream says the
field does not apply to. So the item's "stop writing it on managed services" would have broken every
re-apply: it now goes on every service and `assertZeropsInvariants` refuses a document missing it.
What was actually destructive is `startWithoutCode: true` — re-applying the PROVISIONING document at a
service that carries code activates an empty app version. Corrected the three comments that asserted
reconciliation (`compile.ts`, `topology.ts` ×2, `setups.ts` reason #2). ADR-0003's own text needs no
change: it claims idempotency of `apply-import`, which holds.

**42 — upstream confirmed, and it was costing double.** A live `postgresql:ha@18` with no `profile`
reads back `oltp-production`: 2 DEDICATED cores + 4 GB per container, three containers, twice over.
`db` keeps it (auth latency), `operationsdb` takes `oltp-staging` (same redundancy and ceiling, 1
shared core / 1 GB floor). Light `db`, the example app and the namespace preset are now explicit too.
`verticalAutoscaling` stays unwritten, with the reason stated at the `runtime` helper.

**43 — two new live facts.** All six probe durations are published as `integer` and the platform
REFUSES an integer (`cannot unmarshal !!int into time.Duration`), and every one is bounded to
`[10s, 1h]` (`invalid execPeriod <10s, 1h0m0s>`) — undocumented anywhere. So a schema-valid document is
undeployable. Handled at the two layers the architecture already names: `provider-zerops/src/types.ts`
gains corrected `*Spec` authoring types (`schema.generated.ts` untouched), and
`installation-zerops/zerops/validate.ts` retypes exactly six JSON pointers, throwing if upstream ever
stops publishing `integer`. **This is the one judgement call in the unit — flag it in review.**
Readiness gate proven: identical builds, `/ready` 200 → `ACTIVE`, `/ready` 503 → `DEPLOY_FAILED` with
the previous version still serving.

**45 — the TLS half was backwards.** Port 5432 does speak TLS: `sslmode=require` connects with
`pg_stat_ssl.ssl = true`, `verify-full` fails on a self-signed certificate. So the pinned mode is
`require`, not `disable`. And `dbName`/`user` are literally `db` on every PostgreSQL service whatever
its hostname — checked on `wu2db` — so the database-name fallback is structural, not coincidental, but
still undocumented. Canonical form everywhere:
`${<host>_connectionString}/${<host>_dbName}?sslmode=require`.

Compatibility note for review: `ZeropsSharedPostgresBinding.connectionString` is a literal type that
`parseNamespaceResources` pins, so an artifact persisted with the old literal will no longer parse.
Nothing in the live installation declares `useSharedPostgres()`.

Verified: `typecheck`, `lint`, `format:check` clean; `bun test` 1902 pass / 9 skip / 0 fail with
Postgres on `:55441` (only the S3 suites skip). All four generated setups and both example descriptors
accepted by the live `POST /service-stack/zerops-yaml-validation`.

Out of scope, found while probing: `zops env set` fails with `serviceStackNotFound` — the CLI lists
before writing, i.e. item 41's bug, in the tool rather than in `packages/`. And a `zops deploy` racing
an env write dies on `userDataSyncRunning` with the app version left `UPLOADING`; a retry of
`deployAppVersion` on that version does not recover it. Neither is fixed here.

### 2026-08-05 — WU-3 done (item 40)

**Item 40's harsher claim survives, and this is NOT a special case of WU-2's `override` finding.** On a
brand-new service the import CREATES, `enableSubdomainAccess: true` is accepted and silently dropped:
`subdomainAccess` reads back `false` immediately after create, and still `false` after the service's first
successful deploy. The field is not stored and applied later — it is gone. `override` never enters it.
Settled on throwaway services `wu3app` and `wu3b` inside `fabrika-test`, both deleted; the project is as
it was found.

The fix is an explicit call, and the ordering is forced: `PUT /service-stack/{id}/enable-subdomain-access`
answers `400 serviceStackIsNotHttp` until the service publishes a DEPLOYED HTTP port, which ADR-0004's
`startWithoutCode` bring-up guarantees it does not have at import time. So `ensureSubdomainAccess` runs
after `deployProxy`, on reconcile as well as provision (a subdomain someone turned off comes back), and
throws rather than returning quietly.

**Two facts that shaped the client and would have made a naive version wrong.** The enable's 2xx is not a
success signal — on an already-published service it returns a process that then FAILS — and the read-back
is not always immediate: one live run read `false` right after a successful enable and `true` three
seconds later. So the decision is read → act only if false → read back until true, and the read-back loop
is load-bearing rather than decoration.

Live witness through `packages/`, not through `zz`: fabrika's own `compileProvisioningYaml` document
applied with `createZeropsApi.importServices` created `wu3b` with `subdomainAccess=false`;
`api.enableSubdomainAccess` before deploy threw `ZeropsApiError` with `code === ZEROPS_SERVICE_NOT_HTTP`;
after a deploy the same call plus the read-back loop reached `subdomainAccess=true` on attempt 1 and the
generated host answered `200 "wu3 ok\n"`. Facts + commands → `docs/reference/zerops-platform.md`.

The `installation-zerops` artifacts have no live driver, so the honest fix there is the header: a
generated document that declares a public subdomain now states that applying it publishes nothing and
names the call that does. The declaration itself stays — it is what ADR-0007's `assertOnlyPublicService`
reads.

Also corrected: the local Zerops emulator honoured `enableSubdomainAccess` from an import, so a broken
provisioning path passed against the double. It now ignores the field and serves
`enable-subdomain-access` with the real precondition.

Out of scope, found while reading: `api.ts`'s `importServices` doc comment still marks the `override`
no-op UNVERIFIED, and `artifacts.ts` still describes the steady import as "reconciles drift" — both
contradict what WU-2 settled and what the two CLAUDE.md files now say. Not touched here.

### 2026-08-05 — WU-4 done (item 05, live half)

**The gate drift was one app wide, and the code drift was everything.** Measured before deploying:
`iam-local`, `operations` and `notes` already matched their gate modules at HEAD byte for byte, and
the manifest carried no field the generator has since added — the entire manifest diff was `vozka`,
`{ path: '/*', kind: 'public' }` against fourteen rules (**not fifteen; this file's "Account facts"
miscounted**). What HAD drifted was the deployed code: nothing from the auth-hardening sprint onwards
was live on any service. Deployed builds were `iam` 08-04 14:50Z, `proxy` 08-04 13:54Z, `control`
08-03 13:50Z, `operations` 08-03 13:26Z — i.e. no `__Host-` cookies, no handoff, no deleted SDK
enforcement path, no `FABRIKA_IAM_ADMIN_ORIGINS`, and IAM held **no `apps` row at all**, so `vozka`
had no return-origin registry either.

Deployed with `zops push` (no git remote → no `buildFromGit`), in the order **iam → operations → proxy
→ control**. That is a deviation from the documented IAM → Operations → control, and deliberate: the
application enforces nothing since ADR-0022, so control at HEAD behind the old permissive manifest
would have been an open `/api/*`. Then `reconcileSchema` for `vozka` — the deploy's own call, via
`@fabrika/auth`, exactly as `registerLocalApps` makes it. **Not touched:** `notesapi` (→ backlog 60),
`db`, `storage`, `core`, the five stopped build runtimes, and every other project in the organization.

**Two live defects in the sign-in path, both invisible to the whole test suite, both fixed here.**
Neither is reachable from a test that builds its own `Request`: one is about a header a browser writes
differently from every test, the other about a CSP only a browser enforces.

1. **`Referrer-Policy: no-referrer` makes a same-origin form POST carry `Origin: null`.** Every IAM
   page sets that header, so `sameOrigin` refused **every form on the service** — login, enrollment,
   reset, forgot-password, logout — with 403 `invalid request origin`. Every unit test passed because
   each writes `Origin: <issuer>` by hand. Measured against a local probe serving IAM's exact headers:
   `no-referrer` → `Origin: null`, `Referer` absent; `strict-origin-when-cross-origin` → the real
   origin. Fix: `Origin: null` is decided by `Sec-Fetch-Site`, a header `Sec-`'s forbidden prefix
   means a page cannot write.
2. **Chromium applies `form-action` to the REDIRECT a submission answers with.** So `form-action
   'self'` blocked the 302 to `<app>/__fabrika/auth/callback`: the POST was accepted, a session and a
   code were created, the code was wasted, and the browser sat on the login page with nothing logged.
   Measured on a two-origin probe — same-origin 302 followed, cross-origin 302 blocked, violation
   reporting the ORIGINAL action URL. Fix: the login page widens `form-action` by exactly one origin,
   the app's REGISTERED return origin, so the CSP can never be wider than the registry.
   **Both are judgement calls in security-critical code — flag them in review.**

**The proof.** Anonymous browser at `https://proxy-292c-8082…` → **302 from Caddy** (`via: 1.1 Caddy`)
to `…/auth/login?app=vozka&redirect=…`, never reaching the app; `Sec-Fetch-Mode: cors` gets the 401
envelope with the same `loginUrl`. Typed a password (identity obtained with `passwords.issueReset`,
which answers `{ delivery: 'manual', url }` when email is off — no credential printed anywhere), landed
back on the console, and read Overview, Applications and **Users** — the last through control's
`/iam/admin/*` gateway, which needed `FABRIKA_IAM_ADMIN_ORIGINS` written on IAM first. Two independent
`__Host-px_session` cookies, `Secure` + `HttpOnly` + `Path=/` + host-only, one per host, over the real
TLS-terminating balancer. Revoking the parent then bounced the browser back to login **after the
proxy's 300 s token cache expired** — ADR-0022's stated bound, observed rather than assumed.

Facts → `docs/reference/zerops-platform.md` (the push path, its timings, the two ordering rules) and
`docs/reference/cross-host-sso.md` (the two browser rules + the live run). Filed: backlog
[58](../backlog/58-generate-the-platform-installations-proxy-manifest.md) (nothing generates a
deployed installation's manifest — the real cause of this drift),
[59](../backlog/59-the-live-installation-calls-itself-local.md) (`control` and `operations` carry
`ENVIRONMENT=local`), [60](../backlog/60-the-example-app-has-no-light-tier-descriptor.md) (no committed
descriptor names the shared `db` the example runs on).

Verified: `typecheck`, `lint`, `format:check` clean; `bun test` **1912 pass / 9 skip / 0 fail** against
a real Postgres on `:55445` (only the S3 suites skip).
