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
