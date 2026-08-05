# Sprint — auth track closeout (2026-08-05)

**Goal.** Close every remaining item on the Access-plane track, so the only auth work left is
work nobody has decided yet.

**Theme.** The 2026-08-04 hardening sprint fixed what was _wrong_. It also filed what it found and
could not finish: two identity/lifecycle gaps (54, 55), one piece of design it deliberately deferred
twice (49, and 21 before it), and one pile of test debt it tripped over (53). Individually each is
small; together they are the difference between "the auth track is hardened" and "the auth track is
done". The success condition is an empty auth backlog and a green `test:browser`.

A fifth unit was added beyond those four — see WU-E and the note under **Out of scope**.

## Refs re-verified at HEAD (2026-08-05)

Re-read in the actual code before planning on them. `✔` = confirmed live · `⚠` = drift/nuance caught.

- ✔ Operations' Cloudflare proxy entry declares `appId: 'vozka'` —
  `packages/operations/fabrika.config.ts:82`. Its own `defineApp` says `id: 'operations'`
  (`:94`), and `OPERATIONS_AUTH_APP_ID = 'vozka'` (`packages/operations/src/auth.ts:3`). Three
  names for one service, two of which disagree.
- ✔ A shared manifest cannot carry the duplicate: `parseProxyManifest` refuses a repeated id —
  `packages/proxy-contract/src/index.ts:46`. So the CF shape is not merely different, it is the one
  that cannot be generalised.
- ✔ The local manifest already fronts three distinct apps — `iam-local`, `vozka`, `operations`
  (`packages/local-stack/.state/platform-proxy.manifest.json`). **IAM is itself behind the proxy**,
  which is what makes WU-C possible at all.
- ✔ `OPERATIONS_PROXY_GATES` ends in a `service`/`human` pair over `/api/*`
  (`packages/operations/src/gates.ts:20-25`) — the rules item 54 calls dead.
- ✔ `isDevBypassSession` is checked at USE in exactly three places: `tokens.ts:60`,
  `auth/routes.ts:205`, `admin/router.ts:210`.
- ⚠ **The 55 trap is real and has a second half the item did not record.** The column is
  `CHECK (authentication_method IN ('oidc','password'))` _plus_ a row check tying `oidc` to a
  non-null `idp_sub` and `password` to a null one — `migrations/0009_password_auth.sql:28-34`,
  `migrations-postgres/0003_password_auth.sql:16-22`. A third method value therefore needs BOTH
  checks widened, not just the enum.
- ⚠ `packages/iam/src/auth.ts:16-23` argues in prose that the bypass "carries its own provenance and
  needs no extra column". WU-B overturns that; the comment must go with it, not survive it.
- ✔ No per-client limiter exists anywhere: no `requestIP`, no `CF-Connecting-IP`, no
  `X-Forwarded-For` read in `packages/proxy/src`, `packages/provider-cloudflare/src`, or
  `packages/iam/src`. Green field, and nothing to un-trust.
- ✔ IAM's existing buckets are per-account + deployment-wide, in
  `password_login_throttles` (`packages/iam/src/password-db.ts:279-353`). WU-C keeps them.
- ✔ 198 `VOZKA_*` / `PROPUSTKA_*` occurrences remain under `packages/` — the ADR-0018 fallback,
  still carried.

## Work units

### WU-A — Operations is its own IAM application (effort M) · item 54

- **Problem.** Cloudflare mints `aud: vozka` for the Operations host; the shared proxy must mint
  `aud: operations`; Operations accepts only `vozka`. Two compositions, two answers, and a gate
  list describing routes that 404.
- **Verify first.** Confirm the `/api/*` operator routes really do 404 on the Operations public
  host, and find how the console reaches them today (control's transport-only gateway).
- **Scope.** Decide once — **Operations is its own app** (see Decisions) — then make every
  composition say so: `OPERATIONS_AUTH_APP_ID`, the CF proxy entry, IAM registration (its own
  schema/actions), and whatever grants currently resolve against `vozka`'s vocabulary. Then either
  serve the operator API on the Operations host or delete the rules that pretend it is served. No
  gate rule may survive that describes an unreachable route.
- **Acceptance / witness.** A test asserts both compositions mint the same audience for the
  Operations host and that Operations accepts it; a test asserts every gate path resolves to a route
  that exists. `bun run local:smoke` still passes.
- **Touch points.** `packages/operations/{src/auth.ts,src/gates.ts,fabrika.config.ts}`,
  `packages/local-stack/src/{prepare.ts,app-registration.ts}`, IAM app registration.

### WU-B — one `sessionUsable` predicate (effort M) · item 55

- **Problem.** Disabling OIDC or password leaves already-issued sessions of that method live for
  their full 30 days. Only the dev bypass has the check, and it has it three times over.
- **Verify first.** Re-read the two CHECK constraints above; confirm the bypass's session really is
  stored as `oidc` with `idp_sub = LOCAL_DEV_ADMIN_ID`.
- **Scope.** Give the bypass its own `authentication_method` value so the rule can be stated without
  a special case — a migration in **both** sets widening the enum _and_ the row check. Then one
  `sessionUsable(session, config)` replacing all three `isDevBypassSession(...) && !localDevLogin`
  sites, refusing any session whose method the installation no longer enables. Delete the prose in
  `auth.ts` that argues the column is unnecessary.
- **Acceptance / witness.** A session created under a since-disabled method is refused at mint, at
  `currentSession`, and at `resolveAdmin` — one test per site, on both datastores. `bun run local:up`
  still signs in through `LOCAL_DEV_LOGIN` (this is the trap; prove it, don't assume it).
- **Touch points.** `packages/iam/src/{auth.ts,tokens.ts,db.ts,auth/routes.ts,admin/router.ts}`,
  `packages/iam/migrations*/`.

### WU-C — a per-client limit where the client is actually visible (effort L) · items 49 + 21

- **Problem.** IAM cannot key a limiter on anything trustworthy: behind a balancer its peer is the
  balancer, and a caller-supplied forwarding header is worse than no limiter because it looks like
  protection. So the only per-client bound today is a deployment-wide bucket — one abusive client
  denies the whole installation.
- **Verify first.** Establish what each composition can actually observe, and write it down before
  designing: the CF Worker's managed client address, and what the Bun/Caddy proxy's socket peer is
  on Zerops. **If the Zerops answer needs the live account, say so and design for the answer being
  "the balancer".**
- **Scope.** The proxy is the boundary that sees the real peer and already fronts IAM. Put the limit
  there: strip any caller-supplied forwarding header, inject a composition-specific client
  coordinate the caller cannot set, and make check-and-increment atomic so a concurrent burst cannot
  cross the limit. Keep IAM's account and deployment-wide buckets as defence in depth. Document
  header ownership at every hop. **Where no trustworthy coordinate exists, fall back to today's
  behaviour and say so in the code — never to a spoofable one.**
- **Acceptance / witness.** One abusive client is throttled while another is not; the limit cannot
  be crossed by concurrency, nor bypassed by setting `CF-Connecting-IP` or `X-Forwarded-For` — a
  spoofing test per composition.
- **Touch points.** `packages/proxy/src/`, `packages/provider-cloudflare/src/proxy-worker.ts`, the
  Caddy generator, `packages/iam/src/`, composition tests.

### WU-D — re-author the three drifted browser scenarios (effort M) · item 53

- **Problem.** Three `tests/browser/` scenarios encode an Operations console that stopped existing
  in `83581a9`. Red since. The failure reads as an auth regression to anyone running the suite after
  an auth change — which is exactly how it was found.
- **Verify first.** Drive the console in a real browser and confirm both drifts (filters now apply
  on an explicit `Apply`; the detail headings changed) before touching a line.
- **Scope.** An `opice-reeval`-shaped re-author, not a selector swap: the filter change altered the
  interaction model, so the steps get rebuilt around submit. **Do not weaken an assertion to make it
  pass** — if a scenario can no longer express its intent, say so and re-plan it.
- **Acceptance / witness.** `bun run test:browser -- --tier extended` green, and each re-authored
  step asserts the same intent it did before.
- **Touch points.** `tests/browser/operations-{error-discovery,bulk-status-and-merge,event-release-correlation}.test.ts`.

### WU-E — retire the ADR-0018 legacy env fallback (effort M) · beyond the filed items

- **Problem.** 198 `VOZKA_*` / `PROPUSTKA_*` occurrences remain, kept alive by ADR-0018's
  "legacy fallback" for installations that no longer need protecting. The standing direction for
  this repo is that no backward compatibility is owed and that superseded decisions should not
  linger as if live.
- **Verify first.** Enumerate every alias pair and every reader (`sharedSecret`,
  `environmentAliases.read`, `readResumeEnvironmentAlias`) — the sweep is only safe if the list is
  complete, so find the sites rather than trusting this list.
- **Scope.** Drop the fallback readers and the legacy names, canonical names only. Supersede
  ADR-0018 with an ADR recording that the fallback is retired and why it was safe to retire.
- **Acceptance / witness.** No `VOZKA_`/`PROPUSTKA_` env name remains under `packages/`, `scripts/`,
  `.github/`; `typecheck`, `lint`, full `bun test`, and `local:up` all pass. Durable identifiers
  with `vozka`/`propustka` in their **values** (resource names, database ids) are NOT touched —
  ADR-0018 already separates those, and they address deployed things.
- **Touch points.** `packages/iam/src/node/runtime.ts`, `packages/auth/src/iam.ts`,
  `packages/installation-cloudflare/src/init.ts`, `packages/runner-cloudflare/scripts/`,
  `packages/local-stack/src/smoke.ts`, `docs/decisions/`.

## Out of scope (explicit)

- **The Zerops bring-up track** (05, 39–47, 09, 10). Needs a live account. Unchanged from last
  sprint; still its own sprint, still waiting on a go-ahead.
- **Everything else in the backlog** — 22, 11, 25, 26, 34, 36, 37, 38, 46. None is auth.
- **WU-E is an addition, not a filed item.** It was not in the four items this sprint was scoped
  from. It is here because it is exactly the "legacy decision still standing as if live" the repo's
  standing direction says to remove, and because a 198-site sweep gets harder every week. If it
  turns out to be wider than a sweep, it gets filed and dropped rather than half-done.

## Decisions

- **Operations is its own IAM application, not a surface of `vozka`.** It already declares
  `id: 'operations'`, the shared manifest cannot represent it any other way, and the alternative —
  making it a surface of the control app — would mean the Delivery console's vocabulary governs who
  may triage an incident. The CF composition is the outlier and moves. (WU-A)
- **The dev bypass gets a real `authentication_method` value.** The alternative, exempting it inside
  the predicate, keeps a special case in the one place whose whole value is having no special cases.
  Costs a migration in both sets; worth it. (WU-B)
- **A limiter with no trustworthy key is not built.** Where a composition cannot observe the client,
  WU-C falls back to today's deployment-wide bucket rather than keying on a spoofable header. A
  limiter that looks like protection and is not is the failure mode item 21 refused twice already.

## Sequencing

| Wave | Units       | Why they are parallel                                                              |
| ---- | ----------- | ---------------------------------------------------------------------------------- |
| 1    | WU-A ‖ WU-B | Disjoint: A is `operations/` + compositions, B is `iam/` + migrations.             |
| 2    | WU-C ‖ WU-D | C touches `proxy/` + `iam/` (after B has landed); D touches only `tests/browser/`. |
| 3    | WU-E        | Last on purpose — it sweeps whatever the earlier waves added.                      |

Commit per unit. No `bun run format` repo-wide from inside a unit — `bunx dprint fmt <paths>` on
your own files only; a repo-wide run reformats another agent's in-flight work (this happened last
sprint).

## Run log

<!-- Append as you work: discoveries, deviations, blockers. -->

### WU-B — `sessionUsable` (2026-08-05)

- **A THIRD site seeds sessions, and the plan did not list it.** `packages/iam/src/node/browser-identity.ts`
  created the browser suite's logins with no `authenticationMethod`, i.e. `oidc`, and the browser
  composition runs `FABRIKA_IAM_OIDC_ENABLED=false` — so the naive change would have made every
  `test:browser` identity unusable, which reads as an auth regression and is exactly the failure WU-D
  is already chasing. Seeded as `password` now (the method that stack does enable), which also means no
  `idp_sub`. Verified against the live stack: the seeded login drives the real handoff and reaches the
  console.
- **`local_dev` is the method value.** It matches `LOCAL_DEV_LOGIN` / `localDevLogin`, and it sits in
  the `idp_sub IS NOT NULL` arm of the row check because the bypass records its fixed subject.
- **Two test fixtures were describing an installation that cannot exist** — an OIDC session under
  `{ oidc: false, password: true }` — in `handoff.test.ts` (`scenario()`) and `admin-password-rpc.test.ts`.
  Both now name a configuration that matches the session they create. No assertion was weakened.
- **The SQLite rebuild spends in-flight handoff codes.** `sessions` cannot have a CHECK altered in
  place, and `auth_codes.parent_session_id` cascades from it, so `0013` deletes them explicitly rather
  than letting the outcome depend on whether foreign keys are enforced while it runs. Single-use,
  five-minute codes; the worst case is one login retried. Postgres alters in place and is untouched.
- **`exchangeAuthCode` is deliberately NOT a fourth check site.** A code can only be issued from a
  session `currentSession` already accepted, and every use of the child it produces goes through
  `mintToken`. Recording it because the absence looks like an omission until you follow the path.
- **Blunder, self-inflicted, no damage.** I ran a shell line that included `git stash` while probing
  whether the sprint file was already unformatted, which stashed this unit's work AND WU-A's in-flight
  `packages/operations/src/auth.ts` for about thirty seconds. `git stash pop` restored everything with
  no conflict and the full suite is green. Flagging it because a concurrent agent could have written in
  that window and lost work.
- **`docs/sprints/sprint-2026-08-05-auth-track-closeout.md` fails `dprint check` at HEAD** (the
  Sequencing table's column padding), so `bun run format:check` is red for a reason that predates this
  unit. Left alone rather than reformatted mid-sprint — the file is shared with the other units.

### WU-A — Operations' app identity (2026-08-05)

- **The audience half of WU-A cannot be done in WU-A, and the plan did not see why.** The gate rules
  were correctly called dead — verified on the live stack: a valid machine key on
  `errors.fabrika.localhost/api/issues` passes the `service` gate and gets a **404** from Operations'
  own public-host guard, and the `human` rule's bounce reaches `?app=operations`, which IAM answers
  **400** because the app has never been registered. But the same `OPERATIONS_AUTH_APP_ID = 'vozka'`
  the plan calls an outlier is what makes the console work: the operator surface is reached through
  control's transport-only gateway, so the token Operations verifies was minted by the CONSOLE's proxy
  and carries `aud: vozka`. Measured, not inferred — flipping the constant on the running stack turns
  the console's operator RPC from **200 into 401**.
- **And the console cannot be given an `operations` token where it is.** `mintToken`
  (`packages/iam/src/tokens.ts:57`) refuses a session whose `app` is not the one being minted for, and
  since ADR-0023 every app session is host-only and app-bound. A browser holding a `vozka` session on
  the console's host can never hold an `operations` token there. The surface has to move to the host
  whose proxy mints `operations` — cross-origin console + proxy CORS with a preflight answered before
  gate matching, or the Operations views served from the Operations host. Either is a console
  architecture change with its own ADR, and neither is `packages/operations/` + `local-stack/`.
- **So WU-A shipped its reachable half and re-scoped the rest.** `OPERATIONS_PROXY_GATES` is now the
  two `public` ingest rules and nothing else (the four dead ones deny at the proxy instead of reaching
  a 404), and both compositions name the host by one `OPERATIONS_APP_ID` — the Cloudflare `vozka` entry
  is gone, so a shared manifest can express the shape. `OPERATIONS_AUTH_APP_ID` stays, with the reason
  written where someone would try to change it, and a test that fails if they do.
  → [backlog 54](../backlog/54-give-operations-its-own-proxy-app-identity.md), re-scoped to the move.
- **A general hazard worth naming: control's transport-only gateway pins the upstream's IAM identity
  to the console's.** IAM's admin gateway escapes it only because IAM owns the session store and can
  resolve any session row; no other upstream can. Anything else put behind that gateway inherits
  `vozka`'s vocabulary whether or not that is intended.
- **Not touched, and out of WU-A's scope:** `packages/control/fabrika.schema.ts` still declares
  `operations.*` inside the console's vocabulary — correct today (that is the vocabulary the token
  actually carries), wrong the moment the surface moves. It moves with backlog 54, not before.

### WU-C — a per-client limit where the client is visible (2026-08-05)

- **The plan's "put the limit at the proxy" cannot be taken literally, and the reason is an
  invariant it did not cite.** ADR-0022: _"the proxy holds no state that a decision depends on…
  never make it shared or persistent"_. A counter in the proxy is exactly that, and on Cloudflare a
  per-isolate counter is defeated by the next colo anyway. So the unit split the job the way backlog
  49's own second clause allows: **the proxy observes and injects a coordinate the caller cannot set;
  IAM — which is behind the proxy, and already owns throttle state — does the counting.** The proxy
  stays stateless and there is still exactly one gate evaluator.
- **The atomicity requirement forced a different bucket shape from the two that already exist.** The
  account and deployment-wide buckets READ first and record afterwards; a concurrent burst walks
  straight through that. The client bucket instead decides admission from the `RETURNING` row of the
  single `INSERT … ON CONFLICT DO UPDATE` that increments it, so it counts every attempt rather than
  every failure and a successful login does not clear it. Proved, not asserted: a 120-deep burst buys
  exactly 99 password derivations, and 50 concurrent `recordLoginFailure` calls return the counts
  1…50 with none repeated — on SQLite and on real parallel Postgres connections.
- **`CF-Connecting-IP` is deleted on the way to an app even on Cloudflare, where it is genuine.** An
  app that read it would key on the edge here and on a caller's forgery on Zerops. One header with
  one meaning on both clouds is worth more than the header being locally correct. IAM's own Worker is
  the one exception and reads it directly — it holds its own Custom Domain and is NOT behind a proxy
  Worker, which the plan's "IAM is itself behind the proxy" is only true of the Bun composition.
- **Enabling `trusted_proxies` has a second effect the plan did not mention**: Caddy retains a
  client-supplied `X-Forwarded-Host`/`-Proto` once the immediate peer is trusted
  (`addForwardedHeaders`, v2.10.2). Already defended — `selectApp` cross-checks a pinned `?app=`
  against the app's declared hosts and the login bounce takes its scheme from the manifest — but it
  is a real coupling, so the option is off by default and the consequence is written next to it.
- **Two Caddy semantics were verified against v2.10.2 source rather than assumed**, because both are
  load-bearing: `HeaderOps.ApplyTo` runs deletes BEFORE sets (so the strip and the inject fit in one
  handler), and `client_ip` is resolved once in `PrepareRequest` before any handler runs (so deleting
  `X-Forwarded-For` at ingress cannot change it).
- **The Zerops half is designed for the answer being "no" and is unwired on purpose.**
  `trusted_proxies` is empty, `client_ip` is the balancer, every client shares one bucket — today's
  behaviour. The question is now written where someone with the account can answer it in one sitting
  → [backlog 05, "Still-open semantics"](../backlog/05-bring-up-on-a-real-zerops-account.md) and
  [`reference/zerops-platform.md`](../reference/zerops-platform.md). **Both halves of the answer are
  needed**: the balancer must append the real address AND drop a caller-supplied prefix. Appending
  alone still lets a caller pick its own bucket.
- **Out of scope, found on the way.** (a) `mintToken` still costs one IAM round trip per request
  carrying a garbage session cookie, and bounding THAT at the proxy is what ADR-0022 forbids —
  bounding it in IAM would mean threading the coordinate through the `IamRpc` wire contract on both
  transports, which is its own change. (b) IAM's Worker is directly edge-routed on Cloudflare, so a
  caller there can still choose the `X-Request-Id` that lands in its `auth_log` — the proxy's strip
  never runs in front of it. Neither was fixed.
- Backlog 21 and 49 are both satisfied and left in place for the sprint close to delete, matching
  what WU-A and WU-B did with 54 and 55.

### WU-D — the three drifted browser scenarios (2026-08-05)

- **Both filed drifts confirmed live, exactly as item 53 recorded them.** Typing `merge candidate`
  into `Search` left both rows and changed no URL; `Apply` narrowed to one. The detail's headings are
  `Occurrences` (h2) and `Exception: <type>: <value>` (h3). Nothing had moved again since 2026-08-04.
- **There is a THIRD drift, and it is a data drift, not a console one.** `927340e`
  ("restore issue data parity", 19:35 — four minutes AFTER `83581a9`) made a merge roll the merged
  issue's occurrences into the target's count. `operations-bulk-status-and-merge` asserts the
  canonical's count is unchanged, which was true when it was authored at `41fd84a` (16:53). It was
  invisible because the scenario dies at the merge step and never reaches that assertion — one drift
  was hiding behind another. The application is right and says so in its own test
  (`packages/operations/src/__tests__/operator-api.test.ts:222` pins `count === 3` for a target with
  two merged children). The scenario now asserts `canonical.count + duplicate.count`, which pins the
  roll-up rather than merely tolerating it.
- **The item also under-recorded the second drift: the merge INTERACTION changed, not just the
  headings.** `Merge into issue` is now a search box plus `Find`; a `Merge target` select and the
  `Merge` button only exist once candidates come back. The old step typed the target's opaque id into
  that field, which can never match — the search is `LOWER(title) LIKE … OR LOWER(culprit) LIKE …`
  (`packages/operations/src/repositories.ts:975`), ids are not searchable. Re-planned around
  search-then-pick; the token half of the intent is kept by asserting the picked option's VALUE is the
  canonical's id, so the console is still shown to address the target by an opaque token.
- **Applied filters are component state, not a query string.** A reload returns the list to
  `DEFAULT_ISSUE_FILTERS`, so "persists after navigation" has to re-ask for the same view rather than
  re-visit a URL. Written down once in `tests/browser/support/console.ts`, which every re-authored
  scenario imports.
- **Two scenarios carry the same latent drift without failing, and were left alone**
  (out of WU-D's scope): `operations-issue-triage.test.ts:82` and `operations-sdk-ingest.test.ts:215`
  fill `Search` and never submit. Both then click a uniquely-titled link, so the fill is decorative and
  they pass anyway. Worth a sweep with the next Operations console change.
- **Hazard for concurrent units: the docker stack bind-mounts the repo at `/workspace` and both
  `local:up` and `browser:up` use the compose project name `fabrika-local`.** So another unit's
  in-flight `packages/` edits are live inside my containers, and either command would have torn my
  stack down. WU-C's proxy/IAM edits were in the tree throughout this run; the suite was green with
  them, which is evidence but not a guarantee for whatever they land.

### WU-E — retire the ADR-0018 legacy env fallback (2026-08-05)

- **→ [ADR-0024](../decisions/0024-retire-the-legacy-environment-name-fallback.md).** Canonical
  `FABRIKA_*` names only; ADR-0018 is `superseded by 0024` (status line only, body untouched). Its
  naming rules and its durable-identifier exclusion both survive there.
- **The plan's three named readers were not the list.** `sharedSecret`, `environmentAliases.read`
  and `readResumeEnvironmentAlias` were three of TEN alias helpers over one shared reader:
  `booleanAlias`/`requiredAlias` (IAM), `optionalAlias`/`requiredAlias` (Control, and separately
  Operations' `requiredAlias`/`requiredSecretAlias`), `alias`/`requiredAlias` (the Zerops control
  composition), `aliasValue`/`booleanValue` (IAM's `fabrika.config.ts`), `envAliasValue` (the local
  stack's smoke), plus two alias readers inside `scripts/bootstrap.ts` and `scripts/seed.ts`. The
  one that would have been missed by following the plan's list is
  **`legacyEnvironmentName` in `packages/provider-cloudflare/src/command.ts`** — it derived a legacy
  name from a canonical PREFIX (`FABRIKA_CONTROL_*` → `VOZKA_*`), so it covered names that appear
  nowhere in the repo as a literal and no grep for `VOZKA_` would have found them.
- **Two `ZEROPS_*` alias pairs the sprint plan did not mention were also live** — the Zerops control
  provider read `ZEROPS_{CLIENT_ID,PROXY_BUILD_FROM_GIT,PROXY_IAM_URL,PROXY_IAM_KEY,ACCESS_TOKEN,API_BASE_URL}`
  in `src/node/provider.ts` and `provider-zerops`'s `namespace-command.ts`. Retired with the rest.
  The reason those names are `FABRIKA_ZEROPS_*` in the first place (Zerops reserves the bare
  `ZEROPS_` prefix — `400 userDataZeropsPrefixForbidden`) is preserved where it was, and the test
  that asserts no name starts with `ZEROPS_` stays.
- **The deprecation warnings the suite printed came from `@fabrika/platform`'s `environment.ts`.**
  The whole file is deleted, so the mechanism is gone, not just its inputs. Five packages
  (`auth`, `provider-cloudflare`, `installation-cloudflare`, `local-stack`, `runner-container`) had
  no other use for `@fabrika/platform` and no longer depend on it — the app-facing SDK now pulls in
  only `@fabrika/auth-core` and `jose`.
- **Deliberately left: `VOZKA_APP_ID`** (`packages/control/src/actions.ts:15`, 8 references). It is a
  TypeScript symbol, not an environment variable, and its VALUE is the durable app id `vozka`.
  Renaming the symbol is a readability change with no bearing on configuration; renaming the value is
  a migration. Same for every other durable identifier — `vozka-runner`, `vozka-run-logs`,
  `vozka-deploy`, `vozka-proxy`, `propustka-worker`, the `vozka`/`propustka` D1 databases and app ids.
- **Migration-file comments: SQL untouched, four stale comments rewritten.** `migrations/` is
  immutable history (`packages/control/DATABASE.md`), so this is a judgement call worth flagging:
  the comments named `VOZKA_VAULT_KEY` / `PROPUSTKA_PROVISIONING_KEY` as live configuration and were
  simply wrong, no statement changed, and neither ledger stores a content hash (identity is
  `(bundle, filename)` — ADR-0017), so an applied migration cannot be re-run by the edit. Two more
  (`0003_single_account.sql`, `0005_app_vars.sql`) narrated retired product config; their meaning is
  kept without naming variables that no longer exist.
- **Two `not.toContain('PROPUSTKA_')` guards were kept on purpose** — in
  `installation-zerops/zerops/__tests__/zerops-yaml.test.ts` and
  `installation-cloudflare/src/__tests__/scaffold.test.ts`. They are the proof that the two GENERATED
  files (the root `zerops.yaml`, the scaffolded workflow) emit canonical names, which is also why the
  sweep was safe: nothing outside this repo was ever told an old name by fabrika.
- **Verified:** `typecheck`, `lint`, `format:check` clean; `bun test` 1874 pass / 9 skip / 0 fail with
  `FABRIKA_TEST_POSTGRES_URL` set (only the two S3-backed suites skip — no host-published MinIO);
  `local:up` + `local:smoke` green, then torn down. The smoke is the real witness: the control plane
  boots on `required(source, 'FABRIKA_CONTROL_RUN_LOGS_*')` with no fallback, and every `.state/*.env`
  the stack writes was already canonical.
- **Pre-existing failure, NOT from this unit: `bun run release:validate` is red at HEAD.**
  `@fabrika/provider-cloudflare: public dependencies must not depend on private package @fabrika/proxy`
  — introduced by `18d9575` ("feat(proxy): enforce Cloudflare app routes through proxy"), which made
  the public provider bundle depend on the private `@fabrika/proxy`. Reproduced against a pristine
  `git archive HEAD` copy to be sure. Left alone: flipping `@fabrika/proxy` to public is a
  publishability decision, not an env-name sweep.
