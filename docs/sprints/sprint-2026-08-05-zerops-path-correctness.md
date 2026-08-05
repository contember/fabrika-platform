# Sprint — Zerops path correctness (2026-08-05)

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
