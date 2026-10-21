# A compact installation: applications beside the platform on one HA database

**Status of the idea.** Researched and reviewed (security, feasibility, rollout, simplicity), not decided. The `light`
tier plus a `cheap` namespace with an HA PostgreSQL ("data" preset in the installation guide) reaches nearly the same
price with no code, so this only pays if platform data (users, grants, deploy records) must also survive a node loss.

## The shape

One Zerops project, LIGHT core, every runtime at one container:

| Service                                                        | Type                               | Owner                             |
| -------------------------------------------------------------- | ---------------------------------- | --------------------------------- |
| `db` — the platform database plus one database per application | `postgresql:ha@18`, `oltp-staging` | install                           |
| `storage`                                                      | object storage, private            | install                           |
| `iam`, `operations`, `control`, `proxy`                        | as today                           | platform deploy                   |
| `appproxy`                                                     | `alpine@3.21`, setup `proxy`       | Control, as a namespace reconcile |
| application services                                           | shared database binding only       | Control                           |

Idle floor for three applications ≈ $23, against ≈ $24 for the "data" preset and ≈ $34 for two HA databases in two
projects. Staging applications stay in an ordinary `cheap` namespace (ADR-0006).

## What co-location breaks, and the replacement for each

- **The proxy (ADR-0034).** A namespace finds its proxy by the hostname `proxy` and rebuilds it on every reconcile. A
  second proxy, `appproxy`, owned by Control, keeps one writer per proxy. Merging applications into the platform proxy is
  rejected: Control would rebuild the proxy in front of itself, and one bad entry would fail the rebuild that fronts IAM.
- **The superuser (ADR-0017).** Today an application's `FABRIKA_APP_DATABASE_URL` is its database's superuser. In a shared
  service that reaches IAM. Control instead creates, per application, a role `prov_<id>` (`CREATEROLE`, no superuser) and a
  database `app_<id>` it owns, and writes the existing variable pointing there. `provisionPostgresRoles` and
  `createTestProvisioner` already accept a CREATEROLE caller (since v0.4.0), so the application side does not change.
  One database per application, not a schema in `db`, because advisory locks, schemas and `CREATE` are per database: a role
  in the platform database could hold IAM's public migration lock key (IAM migrates on every start, without a timeout) or
  shadow IAM's unqualified tables through a schema named `db` on the default `search_path`. `REVOKE CONNECT ON DATABASE db
  FROM PUBLIC` keeps application roles out of the platform database altogether.
- **The private network (ADR-0022).** Applications could call `iam`, `control` and `operations` directly. Tokens are
  audience-checked, so no authority is gained, but IAM's trust of `X-Fabrika-Client-Ip` / `X-Request-Id` and Control's
  `service` rows (whose endpoint header is computable) need a proxy secret derived per installation.
- **Hostnames.** The import's `override: true` silently keeps an existing service of the same name, so an application
  whose composed hostname is `db`, `operationsdb` or `appproxy` would shadow a platform service. Reserve the platform
  hostnames in the placement's claims (not at manifest decode: a `full` namespace may legitimately hold `db` today).
- **Connections.** One application can open connections up to `max_connections`. Reserve some for the platform user
  (`reserved_connections`, if Zerops allows setting it) and size the platform pools explicitly.

## Gates before any code

1. [Backlog 198](../backlog/198-an-in-container-env-write-may-reach-another-services-credentials.md): if an in-container env
   write resolves `${db_superUserPassword}`, no co-location is safe.
2. `CREATE DATABASE` works on `postgresql:ha@18`, a created role connects to a non-default database on port 5432, and
   Zerops' automatic backup includes the extra databases (otherwise application data has no backup).

Further facts to measure: `REVOKE CONNECT` keeps pgBouncer on 6432 working for `db`; `ssh` between containers can be
refused for platform services; an application bucket's keys cannot read `storage`.

## Residual risks it would accept

CPU, disk and connections of the shared service are best-effort; role-name squatting between co-located applications;
one bad application entry fails the `appproxy` rebuild for all of them; Control's Zerops token covers platform services;
anyone with a role on the project sees every service's variables, so application teams get none.

## Size

Large: a namespace placement inside the installation project, a Control-side provisioning port (`provider-zerops` stays
HTTP-only), a `compact` tier as a parameter of the light topology, the proxy secret, the claims, and rewrites of ADR-0006,
0017, 0022, 0034 and 0064. A live bring-up closes it.
