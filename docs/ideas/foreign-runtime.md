# A foreign runtime behind the platform

A proposal: let an application written on another runtime framework be delivered, fronted and authenticated by the
platform, while that framework keeps its own data layer. The platform reads the application's surface and access; it
deliberately does not read its data reach.

## The problem

Today only an application on `@fabrika/app` can be deployed. Control reads `fabrika.contract.ts`, `src/db/tables.ts`
and `db/migrations/*` at the pinned commit (`packages/control/src/approval/read.ts`), a commit without a contract fails
with `ContractMissing` (ADR-0050), and the Zerops build and start chain runs `@fabrika/app/build`, `fabrika-check` and
`fabrika db migrate` (`packages/provider-zerops/src/execution.ts`).

Some Postgres-backed frameworks guard their data layer on their own: separate database roles, row-level security,
guarded command execution, a migration ledger, and a startup check of the catalog against a declared schema. Their
strength is that runtime. Rewriting such an application onto `@fabrika/db` throws it away. Running it next to the
platform throws away shared login, proxy enforcement, the approval of who may call what, delivery and Operations.

## What the platform reads from an application

The contract artifact (`ContractArtifact` in `packages/auth-core/src/contract.ts`) and the access snapshot
(`packages/control/src/approval/snapshot.ts`) carry three layers:

| Layer         | Contents                                                                                                      | Consumer                      |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| 1. Surface    | endpoint table (`id`, `method`, `path`, `callers`, `requirement`, `admission`, `delegation`), hosts, CSP      | the proxy manifest            |
| 2. Access     | `actions`, `roles`, `dimensions`, mounts, delegations, workloads                                              | the IAM schema, token `perms` |
| 3. Data reach | `tables` and their policies, `sql` and `unscoped` per endpoint, `files`, `jobs`, migrations and their verdict | the approval diff in Control  |

**A foreign runtime declares layers 1 and 2 only.** Its database is owned by the application: the approval covers who
may call what, and states that the data layer is not read.

## What the foreign runtime implements

Everything below is the platform protocol of ADR-0062; none of it is the framework API.

1. **A statically readable contract.** The framework generates `fabrika.contract.ts` from its own registry of
   operations, permissions and roles, and the application commits it. Control reads it without executing code, as it
   reads any contract; an uploaded artifact stays rejected (ADR-0062, Alternatives). A CI gate in the application
   fails when the generated file drifts from the registry.
2. **Token verification.** It verifies `X-Fabrika-Token` with `@fabrika/jwks` against `FABRIKA_IAM_ISSUER`, checks
   `aud` against `FABRIKA_IAM_APP_ID`, and turns `perms` into its own principal. Its own authorization checks stay
   where they are: in the platform's vocabulary they are authorization, not enforcement (ADR-0022).
3. **The proxy hop.** It serves only the endpoint named in `X-Fabrika-Endpoint`, answers 503 on a digest mismatch, and
   on Zerops refuses a request without the right `X-Fabrika-Proxy-Secret`.
4. **The digest check at startup** against `FABRIKA_CONTRACT_DIGEST`.
5. **A health endpoint**, and the workload key exchange for any declared workload.
6. **No staff login of its own.** Sessions, password reset and CSRF for staff are IAM's; the application has no public
   route.
7. **Optionally, Operations**: any Sentry SDK pointed at `FABRIKA_OPERATIONS_DSN`, tagged with `FABRIKA_RELEASE`.

## What the platform adds

1. **A contract without layer 3.** A form of the contract in which the application declares that it owns its database.
   The reader accepts it without `src/db/tables.ts` and `db/migrations/*`, the snapshot carries no migrations, and
   the approval and the console say that the data layer is the application's.
2. **A dedicated database.** Such a framework needs its own database and cluster-level roles (for example a
   `BYPASSRLS` maintenance role). The platform today provisions a schema `app_<id>` and a DML-only role `run_<id>` from
   the provisioning credential (ADR-0017, `reference/zerops-platform.md`). The provider would provision a database
   whose roles the application's own migrate step creates.
3. **The application's own build and start chain.** The provider runs the application's build, migrate and start
   commands instead of the generated entrypoint and `fabrika db migrate`. The build step is protocol (ADR-0062), so
   this is a second, explicit branch, not a relaxed first one.
4. **The checker's framework rules do not apply.** The refusal of database drivers, S3 clients and token libraries
   (`packages/check/src/rules/modules.ts`) is framework API. The package-replacement rule, which protects the
   packages the platform trusts by name, still applies.

## What is deliberately given up

- The operator does not approve data reach or destructive migrations of such an application. Its own CI and review
  hold that.
- The platform's isolation guarantees for application data (`run_<id>` without DDL, the scoped data layer, the
  generated isolation tests) do not hold for it. The framework's own guarantees replace them, unverified by the
  platform.

## Open questions

1. **Where grants live.** The proxy decides on `perms`, which IAM derives from its grants. Role assignments must move
   from the application's database into IAM. The alternative, a bare `authenticated` requirement for applications, is
   installation-only today and would weaken ADR-0022.
2. **End customers.** A storefront-style application issues its own customer identity on public routes. That needs
   public procedures ([ADR-0063](../decisions/0063-a-public-procedure-runs-as-its-own-workload.md)) and signed tokens,
   and a check that the application's own customer session is authorization, not a second enforcement point.
3. **Tenancy.** Whether the framework's tenancy maps onto IAM dimensions and scopes one to one.
4. **The digest.** The foreign runtime must compute the same digest as the platform. The function that computes it
   would become a published part of the protocol.
5. **The wire shape of an endpoint.** Whether the proxy assumes the framework's procedure encoding anywhere, or
   whether an endpoint's HTTP shape ([ADR-0012](../decisions/0012-fabrika-app-runtime.md) §11) is enough for a foreign
   runtime.

## Order

After [ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md) and the surface revision of
the contract kinds: ADR-0062 makes the protocol the boundary a foreign runtime targets, and the revision supplies public
procedures and the HTTP shape. Open question 1 decides whether the idea is worth pursuing at all.
