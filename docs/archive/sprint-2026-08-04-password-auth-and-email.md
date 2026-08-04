# Sprint — Password authentication and portable email (2026-08-04)

> ## OUTCOME — implemented
>
> Fabrika now has a reusable `@fabrika/email` contract with a fetch-based Resend
> adapter. IAM independently composes OIDC and password authentication, supports
> per-user password enrollment, login, reset, and disable, and uses the same
> single-use action flow for email and manual administrator delivery.
>
> **Commits.** None yet; the implementation and this sprint closure are in the
> working tree.
>
> **Verification.** `cpu-lease run -n 4 -- bun run typecheck` passed across the
> workspace. `cpu-lease run -n 4 -- env FABRIKA_TEST_POSTGRES_URL=... bun test`
> passed 1,651 tests with 9 unrelated S3 suites skipped and no failures; the IAM
> Postgres suite ran against PostgreSQL 17. Biome passed with the repository's
> existing seven warnings, dprint passed, Zerops generated artifacts were current,
> and `git diff --check` passed. The focused security re-audit passed 80 tests and
> found no remaining critical or high-severity issue.
>
> **Deferred.** Operations email targets remain
> [`backlog/46`](../backlog/46-add-portable-email-alert-delivery.md). Trusted
> ingress-owned per-client rate limits remain
> [`backlog/49`](../backlog/49-add-trusted-client-rate-limits-to-public-iam.md).
> A live Resend delivery was not exercised. Release validation now includes
> `@fabrika/email`, then stops on the pre-existing public
> `@fabrika/provider-cloudflare` → private `@fabrika/proxy` dependency tracked in
> [`backlog/25`](../backlog/25-bootstrap-npm-trusted-publishing.md). No live
> Cloudflare or Zerops deployment was run.

**Goal.** Add independently configurable OIDC and password authentication, with secure enrollment and reset delivered through a reusable portable email transport or a manual one-time link.

**Theme.** Password authentication needs an identity lifecycle, recovery path, throttling, and delivery channel. The batch first establishes a runtime-neutral email boundary, then uses one enrollment/reset flow in IAM regardless of whether email delivery is configured.

## Refs re-verified at HEAD (2026-08-04)

- ✔ IAM always constructs one OIDC client and has no independent auth-method switches — `packages/iam/src/services.ts:61`.
- ✔ The current invite operation only creates and audits a principal; it sends no message — `packages/iam/src/admin/handlers.ts:377`.
- ✔ `/auth/login` always starts OIDC outside the explicit local bypass — `packages/iam/src/auth/routes.ts:65`.
- ✔ User invitation status is derived from `external_id IS NULL`, which cannot represent an active password-only user — `packages/iam/src/db.ts:133`.
- ✔ Sessions record an OIDC subject but not the authentication method, so password-only session revocation is not expressible — `packages/iam/src/db.ts:744`.
- ✔ Operations explicitly reports portable email delivery as unsupported — `packages/operations/src/health.ts:299`.
- ✔ Cloudflare materialization currently requires OIDC configuration unconditionally — `packages/iam/fabrika.config.ts:16`.

## Work units

### WU1 — Portable email transport (effort M)

- **Problem.** Fabrika has no runtime-neutral outbound email contract or working adapter, and Operations backlog 46 cannot reuse IAM-specific delivery code.
- **Verify first.** Confirm `@fabrika/platform` forbids its own I/O and that no existing SMTP/API transport is present.
- **Scope.** Add `@fabrika/email`, a provider-neutral sender contract, retry classification, validation, and a fetch-based Resend adapter with injectable transport tests.
- **Acceptance / witness.** Focused tests prove request shape, idempotency, validation, permanent failures, retryable failures, malformed responses, and secret-safe errors on Bun without runtime-specific imports.
- **Touch points.** `packages/email/`, workspace lockfile, ADR/reference package maps.

### WU2 — Password persistence and cryptography (effort L)

- **Problem.** IAM has no password verifier, enrollment/reset token, password-specific throttle, generic activation state, or session method.
- **Verify first.** Exercise the existing D1-shaped repository bundle against SQLite and inspect the Postgres migration ledger requirements from ADR-0017.
- **Scope.** Add immutable SQLite/Postgres migrations, a password capability repository, versioned salted password hashing, one-time action tokens, atomic throttling, generic principal activation, and method-specific session revocation.
- **Acceptance / witness.** SQLite repository and schema tests plus the live-Postgres suite cover equivalent lifecycle, token consumption, rate limits, and session revocation semantics.
- **Touch points.** `packages/iam/migrations*`, `packages/iam/src/db.ts`, password crypto/repository modules and tests.

### WU3 — Browser authentication flows (effort L)

- **Problem.** The only production human flow is OIDC and there is no login form, enrollment, reset, or generic account-enumeration-safe recovery response.
- **Verify first.** Preserve current OIDC PKCE/state, redirect, cookie-domain, and TLS-termination tests before adding routes.
- **Scope.** Derive OIDC-only/password-only/hybrid behavior from independent switches; add same-origin password login, one-time setup/reset forms, generic forgot-password behavior, password-policy validation, audit decisions, and method-tagged sessions.
- **Acceptance / witness.** Route tests cover the full method matrix, CSRF/open redirects, unknown and disabled users, throttling, token expiry/replay, reset revocation, cookie security, and unchanged OIDC behavior.
- **Touch points.** `packages/iam/src/auth/`, services/env composition, route and integration tests.

### WU4 — Administration and delivery (effort L)

- **Problem.** Hybrid mode needs per-user password enrollment state, and the same action must work with configured email or a manually copied link.
- **Verify first.** Confirm the typed admin RPC is the only Access UI mutation surface and that secrets are already displayed once through `SecretModal`.
- **Scope.** Extend the IAM contract and admin use cases with password state, enrollment/reset issuance, cancellation/disable, delivery outcome, audited transitions, and UI controls. Email mode sends the action link; manual mode returns it once.
- **Acceptance / witness.** Admin RPC tests prove authorization and lifecycle; UI typecheck and browser coverage prove email/manual states without exposing verifier or token hashes.
- **Touch points.** `packages/iam-contract`, `packages/iam/src/admin`, `packages/iam-ui`, dashboard route integration.

### WU5 — Configuration, installation, and bootstrap (effort L)

- **Problem.** OIDC is currently mandatory at materialization and password-only installations would have no first authenticated admin.
- **Verify first.** Map Cloudflare Worker vars/secrets, Bun runtime env, local stack, Cloudflare init/workflow, and Zerops generated topology.
- **Scope.** Add explicit independent OIDC/password switches, conditional OIDC requirements, optional email configuration, safe legacy defaults, and a provisioning-key-backed first-admin enrollment command/path for password-only installations.
- **Acceptance / witness.** Config/unit tests cover all four switch combinations, conditional secrets, local composition, Cloudflare generated config, and Zerops schema-validated artifacts; neither-enabled fails closed.
- **Touch points.** IAM composition, installation packages/templates/generated artifacts, CLI/installation contract as required, local stack.

### WU6 — Decision, reference, and release evidence (effort M)

- **Problem.** The auth and outbound-delivery boundaries constrain future providers and stored identity state.
- **Verify first.** Re-read ADR-0007, ADR-0015, ADR-0017, and backlog 46 against the final implementation.
- **Scope.** Record the portable email and composable authentication decisions, update current references/package maps, rescope Operations email backlog honestly, and close this sprint with exact evidence.
- **Acceptance / witness.** Formatting, lint, full typecheck, full tests, real Postgres password suite, and Cloudflare/Zerops generation checks pass; any unavailable credentialed witness is reported rather than inferred.
- **Touch points.** `docs/decisions`, `docs/reference`, `docs/backlog`, docs indices, sprint archive.

## Out of scope (explicit)

- Operations email notification targets remain backlog 46. This sprint supplies the reusable transport but does not change the Operations outbox or operator UI.
- Password MFA, passkeys, account self-registration, and multiple OIDC providers are separate decisions.
- A real Zerops account deployment is not inferred from generated-artifact validation.

## Decisions

- OIDC and password are independent capabilities. Hybrid mode is derived when both are enabled; neither enabled is invalid.
- Email availability is orthogonal to authentication. The same one-time action flow uses provider delivery when configured and a one-time manual link otherwise.
- User password state is `disabled`, `pending`, or `enabled`; global password enablement only makes the mechanism available.
- Users choose their password through an enrollment/reset action. Administrators never set or read it.
- The first provider adapter is Resend over `fetch`, behind `@fabrika/email`; the contract does not expose Resend vocabulary.
- Password-only bootstrap uses the existing provisioning trust boundary to issue the first enrollment, rather than adding a persistent bootstrap password.

## Sequencing

WU1 and WU2 run in parallel. WU3 follows the password repository contract. WU4 follows WU1 and WU2. WU5 can begin from the fixed auth switches but finishes after the runtime composition is concrete. WU6 closes the batch after all witnesses.

## Run log

- Work dispatched across isolated email-transport, password-persistence,
  configuration, public-flow, admin-UI, and security-review subagents; integration
  remained in the root agent.
- Security review drove streamed body limits, fragment-only action tokens,
  bounded KDF work, recovery throttling, atomic action-token issuance,
  case-insensitive invite claims, local-only redirect handling, and provider
  request timeouts. → [`backlog/49`](../backlog/49-add-trusted-client-rate-limits-to-public-iam.md)
- Real PostgreSQL 17 and the full workspace suite passed. S3-backed suites skipped
  because no S3/MinIO service was configured; they do not cover this sprint's
  changed paths.
- Release inventory was updated for `@fabrika/email`; validation then exposed a
  pre-existing public/private dependency boundary. → [`backlog/25`](../backlog/25-bootstrap-npm-trusted-publishing.md)
