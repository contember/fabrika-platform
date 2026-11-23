---
id: 198
title: An application container reaches every credential in its Zerops project
blocked-by: []
---

# 198 — An application container reaches every credential in its Zerops project

**Summary.** Measured live on 2026-11-23: code in a runtime container writes a variable of its own service with
`zsc set-env KEY '${postgres_superUserPassword}'`, crashes its container with `zsc fail-me`, and the replacement
container Zerops starts about 50 s later holds the shared PostgreSQL superuser's password. That password logged in with
`rolsuper = true`. The same works for another runtime service's secret, and needs no API token and no action from
outside the container. So applications that share a Zerops project are not isolated from each other's credentials: a
`cheap` namespace gives every application every other application's schema, and `cheap` and `mid` both give it the
namespace proxy's secrets and every member's own variables. Only a `full` namespace, a project of its own, separates
applications. Security; the mitigation is undecided.

## What was measured

A throwaway project in account `prg1`, deleted afterwards: `envIsolation: service` on the project and on every
service, `postgres` (`postgresql@18`, `NON_HA`), `probe` (`bun@1.3`, which resolved to `ubuntu/bun@1.3`) and
`victim` (`alpine/bun@1.3`, Alpine 3.23.5, an `envSecrets` value set to a random marker). Every attempt ran in the
`probe` service's start command as user `zerops`. That is the user and environment an application process runs with,
and the container held no API token. The reference text was assembled by the shell at run time
(`R='$'; "$R{postgres_super""UserPassword}"`), so no file that Zerops or fabrika reads spelled it. The probe printed
only whether a variable was unset, an unresolved literal or a value. It printed a value's length, a SHA-256 prefix and
whether it opened a superuser connection, never the value. The operator side used the account owner's token through
`zops`, to create, deploy, read logs and restart. None of those steps is something an attack needs, as the last rows
show.

| #  | Call (operator) or command (in the container)                                                                                                   | Answer                                                                                                                                                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1  | `POST /client/{id}/project/import` (`zops project import`)                                                                                      | 200; two `stack.create` processes `FINISHED`                                                                                                                                                   |
| 2  | Build command: `zsc setSecretEnv PROBE_FROM_BUILD "<reference>"`                                                                                | zsc: `Command "set-secret-env" is deprecated, use "zsc set-env --sensitive" instead. Error: [serviceStackIsSystemNotSupported] ServiceStack should not be system`, exit 1                      |
| 3  | `PUT /app-version/{id}/build-and-deploy` (`zops push`) of row 2                                                                                 | The build command ignored zsc's exit code and passed, yet the version is `BUILD_FAILED`: process `stack.build` `FAILED`, error `serviceStackIsSystemNotSupported` naming the build container   |
| 4  | Second push, without the build attempt; start command: `zsc set-env --sensitive PROBE_REF_SENSITIVE "<reference>"`                              | exit 0, no output                                                                                                                                                                              |
| 5  | Same start command: `zsc set-env PROBE_REF_PLAIN "<reference>"`                                                                                 | exit 0, no output                                                                                                                                                                              |
| 6  | Same start command: `zsc setSecretEnv PROBE_EXISTING "<reference>"` (a key the import created through `envSecrets`)                             | exit 0, the deprecation line only                                                                                                                                                              |
| 7  | Before the writes, the same probe on `PROBE_EXISTING` (still the import's placeholder) as the superuser's password                              | Connection refused by the server (`ERR_POSTGRES_SERVER_ERROR`): the check tells a wrong password from a right one                                                                              |
| 8  | `GET /service-stack/{id}/env`, projected to key, type, `sensitive` and "content starts with `${`"                                               | Three `USER` records: `PROBE_REF_PLAIN` `sensitive: false`, the other two `sensitive: true`; each holds the reference literal                                                                  |
| 9  | `PUT /service-stack/{id}/restart` (`zops service restart`)                                                                                      | `stack.restart` `FINISHED`. The new start: all three variables resolved to a 24-character value; each opened `postgres@postgres:5432/db` as `postgres`, `rolsuper = true`                      |
| 10 | `POST /project/{id}/service-stack/import`, then a push of `victim`                                                                              | `victim` ACTIVE                                                                                                                                                                                |
| 11 | In `victim`: `sudo -n true`; a Bun child calls `prctl(PR_SET_DUMPABLE, 0)` through `bun:ffi` as `undumpable.ts` does, holding a marker variable | `sudo` works without a password, as on `ubuntu/bun@1.3`. `prctl` returned 0. Another `zerops` process cannot read the child's `/proc/<pid>/environ`; `sudo grep` finds the marker in it        |
| 12 | Third push of `probe`; its start command finds `PROBE_REF_SENSITIVE` still resolved (superuser, `rolsuper = true`)                              | A written variable survives a redeploy                                                                                                                                                         |
| 13 | Same start command: `zsc set-env --sensitive PROBE_REF_VICTIM '${victim_VICTIM_SECRET}'` (assembled the same way), then `exit 1`                | exit 0. Zerops restarted the start command 2 s later in the same container with the old environment: `PROBE_REF_VICTIM` unset                                                                  |
| 14 | Then `zsc fail-me`                                                                                                                              | exit 0; the container went `FAILED`. A replacement container started 50 s later: `PROBE_REF_VICTIM` resolved, its SHA-256 prefix equal to the marker's; the superuser reference still resolved |
| 15 | `DELETE /project/{id}` (`zops project delete`)                                                                                                  | `project.delete` `FINISHED`; the organization's project list is as before                                                                                                                      |

The platform facts are recorded in
[`zerops-platform.md`](../reference/zerops-platform.md#verified-live-2026-11-23-account-prg1-a-throwaway-project-since-deleted--a-container-writes-its-own-variables).

## What it means for fabrika

- **The trust boundary on Zerops is the project.** `envIsolation: service` decides only what a container starts with.
  Code in any service can make Zerops resolve any `${<host>_<KEY>}` of the project into its own environment.
  fabrika's reference checks (`src/service-references.ts` on the manifest, `interpolateManifest`, `secrets.put` and
  the source descriptor) bound what fabrika writes; nothing bounds what the container writes.
- **`cheap`:** every application reaches the shared `postgres` superuser and with it every application's schema, and
  `COPY … PROGRAM` on the database server ([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)).
- **`cheap` and `mid`:** every application reaches the variables of the namespace proxy (every member's proxy secret),
  of the namespace's `zbox` host when it has one (`ZBOX_WORKSPACE_API_KEY`), and of every other
  member's services: its token keys, workload keys and, in `mid`, its own PostgreSQL superuser. The mechanism was
  measured for a managed service's generated credential and a runtime service's secret; this list applies it to the
  names fabrika writes.
- **`full`:** the project holds one application. It reaches its own database superuser, which it shares a container
  environment with anyway, and the namespace proxy's variables: its own proxy secret and the key below.
- **Every preset:** the namespace proxy holds the installation-wide proxy key of IAM's mint surface
  (`FABRIKA_IAM_KEY`; ADR-0022: every namespace proxy holds that one), so any application reaches it. It opens
  `/auth/mint/*`, which mints only from a credential of the caller (a session cookie, a `px_` key, a handoff code and its
  verifier); what that adds for a holder of no such credential is not assessed here.
- **The installation's own project is not affected while no application shares it**
  ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)). A co-located installation
  ([`compact-installation.md`](../ideas/compact-installation.md)) would give every application the platform's keys.
- **The build is closed:** a build container cannot write a variable (rows 2–3), and fabrika refuses the reference in
  descriptor text Zerops would resolve.
- **Drift:** ADR-0017's Decision says the application's process never holds the provisioning credential. Its own
  Consequences already concede that the launcher protects only where the application runs unprivileged, and that a
  Zerops application has passwordless `sudo` (verified 2026-10-21). New here: `sudo` reads a non-dumpable process's
  environment, on `alpine/bun@1.3` too (row 11), and with `zsc` the application does not need the launcher at all.
  [ADR-0014](../decisions/0014-provider-owned-deployment-namespaces.md) and
  [`deployment-namespaces.md`](../reference/deployment-namespaces.md) already call a `cheap` namespace one trust
  boundary between its applications, but not `mid`.

## Options

Estimates are elapsed agent time, review and CI included.

| Option                                                                                                                                                                                                                                                                                                         | What it closes                                                                                                                                                           | Cost                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. **A namespace is one trust domain.** Say in ADR-0014, ADR-0017, `deployment-namespaces.md`, the security pages and the guide that applications in a `cheap` or `mid` namespace trust each other, and that applications that must not reach each other's data go into `full` namespaces                      | Nothing technically; it makes the boundary the one Zerops has, and states which preset to pick                                                                           | 1–2 h, docs only. Money: one project and one proxy per application that needs isolation                                                                                                                                                                      |
| 2. **Run the application without the container's powers.** The generated start script and the crontab start the launcher, and the launcher the application, as a dedicated user without `sudo` and without whatever `zsc` authenticates with. First measure that (an environment variable, a file or a socket) | `zsc` and `sudo` for application code, so `cheap` and `mid` hold for application code. Init commands, the start script and authored build commands still run as `zerops` | Measurement 1 h, change 4–8 h. It changes the generated start script, so a platform release reaches every application at its next deploy without a framework upgrade. Any file the application writes, its Bun cache and the jobs need the new user's rights |
| 3. **A per-application database credential that is not a superuser**, the candidate this item named before the measurement                                                                                                                                                                                     | Alone, nothing: `${postgres_superUserPassword}` stays a variable of a service in the same project. With option 2 it removes the superuser from the application container | 4–6 h on top of option 2                                                                                                                                                                                                                                     |
| 4. **Ask Zerops** for a service setting that keeps other services from referencing its variables, or that applies `envIsolation` to references, or that switches `zsc` writes off                                                                                                                              | Everything at the platform layer                                                                                                                                         | An issue to Zerops; their timeline. Zerops documents cross-service references under isolation as intended behaviour                                                                                                                                          |
| 5. **Detect.** On deploy and reconcile, Control reads each application service's variables and alerts on a record it did not write                                                                                                                                                                             | Nothing in time: the application triggers its own restart within a minute. A `sensitive` record may read `REDACTED`, depending on the token's sudo mode                  | 2–3 h                                                                                                                                                                                                                                                        |

Option 1 is the cheapest true statement and should land whatever else is chosen. Option 2 is the one fix fabrika
controls; it needs its own measurement first.

## Touch points

`docs/decisions/0014-provider-owned-deployment-namespaces.md`, `docs/decisions/0017-service-owned-postgres-migrations.md`,
`docs/reference/deployment-namespaces.md`, `docs/reference/security-runtime.md`,
`docs/reference/security-guarantees.md`, `packages/provider-zerops/src/installation/guide.md`; for option 2
`packages/provider-zerops/src/execution.ts`, `packages/app/src/build-recipe.ts` and the launcher in `@fabrika/app`.

<!-- Origin: the security review of the co-located installation plan (docs/ideas/compact-installation.md). -->
