# Sprint — Unified Fabrika console (2026-07-30)

**Goal.** Replace the separate control and IAM dashboards with one operator
console while keeping both backend services and authorization boundaries
independent.

**Theme.** One frontend shell and one browser origin. Control owns deployment
operations. IAM owns identity, policy, credentials, and audit. A narrow HTTP
gateway joins their operator surfaces without joining their domain logic.

## Refs re-verified at HEAD (2026-07-30)

- ✔ `@fabrika/dashboard` and `@fabrika/iam-ui` use the same React/Buzola stack
  and nearly identical visual primitives, but build separate SPAs and shells.
- ✔ Control serves `/api/*` and its SPA; IAM serves `/admin/*`, `/auth/*`, JWKS,
  and its SPA from separate origins.
- ✔ IAM authorizes every `/admin/*` request itself. Forwarding the request does
  not move authorization into control.
- ✔ The Cloudflare IAM service binding exposes both RPC methods and `fetch`;
  the Zerops control runtime already has a private IAM HTTP origin.
- ⚠ Local browser access cannot use real OIDC without an external provider.
  The full local stack already has a generated provisioning credential suitable
  for a local-only gateway identity.

## Work units

### WU1 — Add a narrow IAM admin gateway

- Add a runtime-neutral fetch port for IAM administration.
- Route `/iam/admin/*` through control while preserving method, cookies, body,
  response, and IAM-owned authorization.
- Preserve CSRF checks across the private HTTP hop.
- Inject the provisioning identity only in explicit local dev mode.

### WU2 — Turn IAM UI into a console feature package

- Remove its standalone application shell and build.
- Export IAM routes, components, hooks, and feature styles.
- Mount its routes below `/access/*` in the control dashboard.
- Keep IAM DTOs sourced from `@fabrika/iam/admin`.

### WU3 — Build one professional operator shell

- Group the control rail into Delivery and Access planes.
- Use one Fabrika identity, denser operational hierarchy, restrained status
  color, and consistent data typography.
- Preserve all existing workflows and responsive behavior.

### WU4 — Remove the second deployed UI

- Build only the unified dashboard.
- Stop provisioning IAM with a separate asset bundle.
- Update Cloudflare, Zerops, and local composition references.

### WU5 — Prove the integrated surface

- Add gateway and route-generation tests.
- Exercise Delivery and Access pages through the running local proxy.
- Run the full local smoke, typecheck, tests, lint, and format checks.

## Out of scope

- Merging IAM and control databases or backend packages.
- Moving IAM authorization or audit decisions into control.
- Redesigning the public application login experience.
- Compatibility redirects for the removed standalone IAM dashboard.

## Decisions

- The console is a presentation-plane composition, not a service merger.
- The gateway transports `/admin/*`; IAM remains the only authority for it.
- Existing `@fabrika/iam-ui` becomes the IAM console feature package rather than
  adding another package with duplicate components.
- The interface remains a dense borders-only operations tool. Its signature is
  a control rail split into Delivery and Access planes.

## Sequencing

WU1 establishes the same-origin API seam. WU2 and WU3 compose the frontend on
top of it. WU4 removes redundant deployment work. WU5 validates the result.

## Run log

- 2026-07-30 — Started after the local stack exposed the operational cost of
  separate browser origins and separate admin shells.
