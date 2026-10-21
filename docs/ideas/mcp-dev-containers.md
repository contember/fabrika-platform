# A dev environment for MCP authoring

A proposal: give an application an opt-in `dev` environment whose Zerops service builds once, then takes each
workspace commit within about two seconds. A platform-owned launcher in the container pulls the changed files of the
committed head from Control, migrates the environment's own schema, and restarts the application. The stage build
stays the gate: checks, tests and the approval path are unchanged for every environment except `dev`.

## The problem

Today the MCP loop is `apply_changes` → `deploy_stage` → an ordinary run
(`deployStageUseCase`, `packages/control/src/api/workspaces.ts:240`). The run writes service variables, uploads the
commit archive, and triggers a Zerops build (`packages/provider-zerops/src/plan.ts:33-66`). The generated build
installs dependencies, runs the application's tests, `fabrika-check`, `tsc` and the SPA build. The deploy runs
`migrate`, `db codegen --verify` and `db test-isolation` before readiness (`packages/provider-zerops/src/execution.ts:272-424`).
On the test installation one `notesapi` build process took 80–142 s, after about 15 s of serial variable writes;
[`zerops-platform.md`](../reference/zerops-platform.md) records 3 min 08 s for the example application. An agent that
iterates on a handler or a screen waits that long for every attempt.

The constraints that shape any faster loop:

- The proxy is the only public route to an application ([ADR-0022](../decisions/0022-the-proxy-is-the-only-enforcement-point.md)).
  An application service gets no subdomain ([ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md)).
- The agent holds an MCP token and nothing else: no Zerops, GitHub or database credential
  ([ADR-0049](../decisions/0049-author-applications-through-mcp-in-control.md)).
- The application process never holds the provisioning credential
  ([ADR-0017](../decisions/0017-service-owned-postgres-migrations.md)).
- Control runs in the platform project. A namespace is another Zerops project, and projects share no private network.
- Control has no runner on Zerops ([ADR-0003](../decisions/0003-no-deploy-runner-on-zerops.md)). It cannot build an
  artefact itself.

Zerops' own ZCP solves the loop with a `startWithoutCode` dev service, SSHFS-mounted code and an agent that holds an
operator token. Each of those three parts breaks one rule above.

## Measurements

All measurements ran on 2026-10-21 against the `fabrika-mcp-apps` namespace (Prague region), on a throwaway Bun
service `devspike1` (`ubuntu/bun@1.3`, one container). The service is deleted.
"Serving" means: the first HTTP response through the service's subdomain that carries the new version. The subdomain
was a measurement aid only.

| Mechanism                                                      | Change → serving                             | Runs                      |
| -------------------------------------------------------------- | -------------------------------------------- | ------------------------- |
| In-container agent: write file, `bun --watch` restarts the app | **0.07–0.18 s** (HTTP PUT 0.04 s)            | 6                         |
| `zops deploy` of a prebuilt artefact (deploy phase only)       | 21–43 s; each deploy process 36 s            | 4                         |
| `zops push` with a one-line build (pipeline floor)             | 51–53 s                                      | 2                         |
| Ordinary Fabrika build of `notesapi` (build process only)      | 80–142 s, plus about 15 s of variable writes | 3 (from the process list) |
| `zops service restart`                                         | 17–19 s                                      | 4                         |
| Stopped → `service start` → serving                            | 8.9 s                                        | 1                         |
| Create a service with `startWithoutCode`                       | 13.6 s                                       | 1                         |

Supporting facts, each verified on that service:

- **Control is unreachable from a namespace.** From inside the namespace, `postgres:5432` and `notesapi:3000`
  connected in 1–19 ms. `control:3000`, `control.zerops:3000`, `iam:3000` and the container name
  `node-id-5.runtime.control.zerops` all failed. SSH or SFTP from Control into a namespace container would need a VPN
  client and a new key in Control.
- **Egress to Control works.** A request from the container to Control's public origin returned 200 in 15–68 ms.
- **Files written at runtime survive `service stop`/`start` and `service restart`.** A deploy replaces the container
  and loses them.
- **The application user has passwordless `sudo`.** `sudo -n true` exited 0 as uid `zerops`. The runtime environment
  also carries `ZEROPS_CertKey` and `ZEROPS_CertCrt`. ADR-0017 already lists `sudo` as the way past the launcher's
  non-dumpable protection. A dev container does not change this. Unreviewed code reads whatever the container holds.
- **GitHub reads are fast enough.** A compare between two commits took 0.52–0.65 s, and one raw file took 0.35–0.40 s.
- **A real application restarts in well under a second.** Importing the CRM's module graph (`examples/crm/src/app.ts`)
  took 160–220 ms locally. Its SPA build took 2.7 s, and `tsc --noEmit` took 13 s.

Not measured: how long `apply_changes` takes. It writes a blob, a tree, a commit and a ref through the GitHub API,
so about 1–3 s is a fair estimate.

## Options

| Option                                                        | Latency after the commit                               | Security                                                                                                                                          | Cost                                                                | ADR changes                                                |
| ------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| A. Today's run (stage)                                        | 2–4 min                                                | Full gate                                                                                                                                         | None                                                                | None                                                       |
| B. A faster full build (another agent's work)                 | Floor 51 s measured; 60–90 s realistic                 | Full gate                                                                                                                                         | None                                                                | None                                                       |
| C. Control pushes over SSH/SFTP (the ZCP model)               | About 1 s, if it could connect                         | A VPN client and an SSH key in Control; a codeless service; ZCP gives the agent operator rights                                                   | One container                                                       | 0043 (`startWithoutCode`), 0049, plus a new VPN credential |
| D. `zops deploy` of a prebuilt artefact                       | 21–43 s, plus a build somewhere                        | Needs a builder that Control does not have on Zerops                                                                                              | One container                                                       | 0003, 0043                                                 |
| E. In-container agent, Control pushes over a public route     | About 1–2 s                                            | A second public route to the service, beside the proxy                                                                                            | One container                                                       | 0022, 0043 (a subdomain): refused with no approval path    |
| **F. In-container launcher pulls from Control (recommended)** | **About 1–2 s** (0.1 s apply + 0.5–0.7 s GitHub + RTT) | No new ingress; no Zerops, SSH or VPN credential; one scoped workload key in the container                                                        | One container per app; one schema; one proxy host                   | 0049, 0043, 0064, 0062 (additions; below)                  |
| G. `fabrika app dev` run remotely                             | About 1 s                                              | Loopback only, and its stand-in IAM issues tokens. That conflicts with ADR-0022 (no credential-less caller, an application issues no credentials) | One container                                                       | 0022, 0035: rejected                                       |
| H. F per workspace                                            | About 1–2 s                                            | As F                                                                                                                                              | One container, schema, proxy host and access approval per workspace | As F, plus per-workspace environments                      |

B and F do not compete. B shortens the path to stage and production. F removes the build from the inner loop. A full
build cannot go below the measured 51 s floor, because a Zerops pipeline creates a build container and deploys a new
runtime container on every run.

## Recommended design: option F

### The environment

- An application may have one environment of kind `dev`. It is registered like any other environment: its own service
  (hostname `<app>dev`, which fits `^[a-z0-9]{1,25}$`), its own schema and role family, its own proxy host, proxy
  secret and approved access. ADR-0022 routing is unchanged: the namespace proxy is the only ingress, and the dev
  service has no subdomain.
- A `dev` environment is never protected and never production. It must not hold production data, the same operator
  rule that ADR-0050 states for staging.
- It shows one workspace at a time, like the authoring stage environment today.

### Bootstrap: an ordinary run

The first deploy of a `dev` environment is an ordinary run of the workspace head, with the full build and its checks.
It is not a codeless import, so ADR-0043's refusal of `startWithoutCode` stands. The provider renders one difference in
the platform-owned `run` section: `start` runs the generated dev launcher instead of the serving entry.

A new bootstrap run is needed when the commit changes something the build owns:

- `package.json` or `bun.lock`;
- `fabrika.contract.ts` or a schema module it imports (the contract digest and the proxy table change; access applies at
  once, because `dev` is unprotected);
- the framework pin.

### The inner loop

1. The agent calls `apply_changes`. It commits to the workspace branch, as today.
2. When the workspace is bound to the `dev` environment, Control records the new head for that environment. This record
   is metadata, not a run.
3. The dev launcher holds a long poll on Control's public origin. It authenticates with a workload key of a new
   receiver, `source` ([ADR-0064](../decisions/0064-applications-reach-the-platform-over-a-receiver-verified-transport-key.md)),
   issued per `<app>@dev` like every other platform key.
4. Control answers with the head SHA and the changed files. It reads them from GitHub (a compare), relays them, and
   stores nothing. ADR-0049's "Control stores workspace metadata only, never file contents" holds.
5. The launcher writes the files and reconciles. It migrates when `db/migrations/` changed, runs the authored SPA build
   when the web sources changed, and respawns the application. It respawns instead of using `bun --watch`, so it controls
   the order and knows when the new head serves.
6. The launcher reports `{ head, status, last log lines }` to Control. A new tool, `get_dev_status`, returns it. If the
   commit needs a bootstrap, the launcher refuses the sync and says so in one line.

The launcher is the existing launcher pattern of ADR-0017. It holds `FABRIKA_APP_DATABASE_URL`, loads no application
module, runs migrations, and starts the application with the runtime credential only. The serving launcher already
lives as the parent for the life of the process, so the credential's exposure does not change.

At boot (after a stop, a restart or a container replacement), the launcher reconciles to the environment's recorded
head before it serves. That makes the persistence of runtime files an optimisation, not a dependency.

### Checks

- On a sync, the launcher runs no checks. A new tool, `run_checks`, runs the build's check chain inside the dev
  container on request: tests, `fabrika-check` and `tsc` (13 s for the CRM locally). The tool reports the results;
  it gates nothing.
- Promotion is unchanged. `deploy_stage` builds the head in the stage environment with every check, and production
  is a human merge. Nothing from a `dev` container is promoted. Only the commit is, and it is rebuilt.

### Data

- The dev schema is the environment's own `app_<id>` family, created by the ordinary provisioning step.
- Migrations under development get edited and rewritten, so a `reset_dev` tool drops the dev environment's schema
  and role family and migrates from scratch. It exists only for kind `dev`.
- Switching workspaces syncs the new head's full tree and resets the schema.

### Credentials

| Holder        | Holds                                                                                                               | New               |
| ------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------- |
| Agent         | The MCP token (`authoring` scope)                                                                                   | No                |
| Control       | Its Zerops integration token (owner of the namespace project) and the GitHub App                                    | No; no SSH or VPN |
| Dev container | The usual application environment, plus the `source` key: read only, the bound workspace's files of one `<app>@dev` | One key           |

Unreviewed code in the container can read the `source` key. The key reads only source the code already runs, so it
grants nothing new. The container's wider exposure (`sudo`, the Zerops certificate key, the provisioning credential
behind the launcher) is the same as stage's today, which also runs unreviewed workspace heads.

### Lifecycle and cost

- One `dev` container per application, pinned to one container: runtime files live in one container.
- Control stops the service after a configurable idle period with no sync. The next `apply_changes` starts it, and a
  start serves in about 9 s.
- In a `zerops-subdomain` namespace the proxy publishes six hosts, one per HTTP port. A `dev` environment takes one of
  them. A `custom-domain` namespace has no such limit.
- A bootstrap takes a namespace lease ([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)).
  A sync is not a Zerops operation and takes none.

## ADR changes (drafts)

- **ADR-0049.** Replace "Per-workspace previews are future work" with: "An application may have one `dev`
  environment. A commit to the workspace bound to it reaches the running service through the dev launcher, without a
  run. `deploy_stage` stays the only path to a checked build. Per-workspace environments are future work." Add the
  tools `get_dev_status`, `run_checks` and `reset_dev` to the tool table.
- **ADR-0043.** Amend "An application cannot start outside the generated entrypoint, skip its migrations or skip the
  checks" to: "...except in a `dev` environment, which starts through the generated dev launcher, migrates on every
  sync, and runs the checks only on request. The environment kind selects the `run` variant. An application never
  authors it." The exposure refusals, including `startWithoutCode`, do not change.
- **ADR-0064.** Add the receiver `source`: a key per `<app>@dev`, read only, for the bound workspace's files at a
  named head. Control relays from GitHub and stores nothing.
- **ADR-0062.** The dev launcher, the `source` receiver and its variables are protocol additions. Dev mode requires
  the framework minor that ships the launcher. A platform refuses dev mode for an older application and keeps the
  ordinary loop for it.
- **ADR-0017.** No rule changes. Add a consequence: in a `dev` environment the launcher migrates on each sync, and
  `reset_dev` drops and recreates that environment's role family.
- **ADR-0050.** Add: a `dev` environment is never protected and cannot be marked protected.
- **ADR-0022.** No changes.

## Open questions

- Should the authoring stage environment itself run in dev mode, instead of a separate `dev` environment? That would
  save one container and one proxy host. The cost is that no environment would show the checked build of a workspace
  before the pull request.
- Should a lockfile change install in place (`bun install --frozen-lockfile --ignore-scripts` in the container) instead
  of a bootstrap? That is seconds instead of minutes, but it moves a build step into a long-lived container.
- How should application logs reach the agent? Options are the launcher's last lines in `get_dev_status`, or the
  Operations plane. The launcher must never forward the environment.
- Should Control push the head to the long poll at commit time, or should the launcher ask on a timer? A push saves one
  round trip.
- Which permission does `reset_dev` need? `deploy.trigger` alone, or a new one?
- How long should the idle period be, and does Zerops bill a stopped service's disk?
