# A Google Cloud provider

**Status of the idea.** Researched on 2026-11-24 from the code at `11e8da5bf` and Google Cloud's documentation. Nothing
deployed, no Google Cloud project touched. Not decided. The prerequisites every cloud shares, and how Google Cloud
compares with AWS and Azure, are in [Fabrika on the big three clouds](cloud-providers.md); this page holds what is true
of Google Cloud.

## The short answer

The obvious choice, Cloud Run, is the wrong one for Fabrika, and GKE Autopilot is the right one. Cloud Run bills an
always-on instance that does background work (Control, Operations' consumer, every application with jobs) only at 1 vCPU
or more, has no init containers, keeps services private only through IAM invoker tokens, and offers custom domain
mapping only in preview and not in europe-west3. GKE Autopilot runs pods from 0.25 vCPU, enforces NetworkPolicy by
default, has init containers, Jobs and CronJobs, keyless Workload Identity, and its cluster fee is covered by a monthly
free-tier credit for the first cluster of a billing account. The same six containers cost about $70 a month in compute
on Autopilot and about $300 on Cloud Run (US list prices).

That makes the Google Cloud provider a **Kubernetes provider** with Google's managed services around it: Cloud Build and
Artifact Registry for images, Cloud SQL for PostgreSQL, Cloud Storage, a Gateway with Certificate Manager. Written
with the Kubernetes half as a library, it is also the provider an operator who mandates Kubernetes on AWS or Azure
would get ([the comparison](cloud-providers.md#one-kubernetes-provider-instead)).

Effort: the shared prerequisites (about 22–35 person-days, once for every cloud), then about 41 for a first usable
Google Cloud provider and 53–81 for parity. A small installation costs about $150 a month at US list prices; Frankfurt prices
were not readable.

## How Google Cloud maps onto the provider contract

| Fabrika concept                           | Zerops today                                                 | Google Cloud                                                                                            | Rejected                                                                            |
| ----------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Installation (one cloud, ADR-0011)        | One Zerops project for the platform                          | One Google Cloud project and one regional GKE Autopilot cluster in europe-west3                         | A project per namespace                                                             |
| Long-running service                      | Zerops runtime service, `alpine/bun@1.3`                     | A Deployment with explicit requests (0.25 vCPU, 0.5 GiB and up), behind a ClusterIP Service             | Cloud Run, Compute Engine, GKE Standard                                             |
| Build (ADR-0003: no runner)               | Zerops build container, triggered over REST                  | Cloud Build `builds.create` from a Cloud Storage tar.gz; image to Artifact Registry, deployed by digest | Building in the cluster (no privileged pods)                                        |
| Source transport (ADR-0029)               | Control streams the GitHub tarball to the app version upload | The same stream into a Cloud Storage resumable upload session Control opens                             | One signed-URL PUT (chunked is undocumented)                                        |
| Deploy and activation                     | `build-and-deploy`, readiness check gates activation         | Patch the Deployment; a rolling update with `maxUnavailable: 0` and a readiness probe gates it          |                                                                                     |
| Migrations                                | `run.initCommands` on every container start                  | A Kubernetes Job with the new image runs `migrate` once, before the Deployment is patched               | An init container (per pod start)                                                   |
| Run checkpoint and recovery (ADR-0044)    | `{ appVersionId, triggered }`                                | `{ buildId, jobName, generation }`, each recorded before the call that needs it                         |                                                                                     |
| Secrets (ADR-0004)                        | Sensitive service variables                                  | Kubernetes Secrets in the application's namespace, read as environment at pod start                     | Secret Manager with the CSI driver                                                  |
| Managed environment                       | Service variables plus literals in the descriptor            | The container's `env`, literal or `secretKeyRef`, written per run                                       |                                                                                     |
| Deployment namespace (ADR-0014)           | One Zerops project with its own proxy                        | One Kubernetes namespace with its proxy Deployment and a default-deny NetworkPolicy                     | A cluster per namespace                                                             |
| Private network trust (ADR-0022 rule 5)   | Everything in a project reaches every port                   | NetworkPolicy: an application's pods admit traffic only from their namespace proxy's pods               | Cloud Run internal ingress with invoker IAM                                         |
| Public entry and TLS                      | Project L7 balancer, Zerops subdomain or custom domain       | Gateway API `gke-l7-global-external-managed`, Certificate Manager, an HTTPRoute per proxy host          | Ingress `ManagedCertificate`, domain mapping                                        |
| PostgreSQL                                | Managed `postgresql:single@18` / `ha@18` service             | Cloud SQL for PostgreSQL 18, Enterprise edition, `db-custom-1-3840`, private IP, shared CA              | AlloyDB, shared-core tiers, Enterprise Plus (until 35-day PITR is asked for)        |
| Object storage                            | Zerops object storage (MinIO), static keys                   | Cloud Storage through its XML API with an HMAC key first; a native adapter on the JSON API later        | Signed-URL uploads from browsers (unused)                                           |
| Outbound email (ADR-0019)                 | An adapter (Postmark, Resend, …) or Control's relay          | The same adapters; Google Cloud has no transactional email service                                      |                                                                                     |
| Cron (`run.crontab`)                      | Zerops crontab in the container                              | The serving process keeps cron wakes (shared prerequisite N7)                                           | A CronJob per cron job (fallback)                                                   |
| Service logs                              | Zerops project log service                                   | Cloud Logging (first 50 GiB a project free, 30 days in `_Default`)                                      |                                                                                     |
| Installation tooling (ADR-0025, ADR-0027) | `platform install/deploy/upgrade --provider=zerops`          | Terraform with the Google provider in the operator's pipeline; Control uses REST and the Kubernetes API | Deployment Manager (shut down 2027-06-30), Infrastructure Manager, Config Connector |
| Sidecar pipeline credential               | A Zerops integration token in a GitHub Environment           | Workload Identity Federation for GitHub Actions                                                         | A service account key                                                               |

## The service choices

### Compute: GKE Autopilot, not Cloud Run

- **Cloud Run (rejected).** Below 1 vCPU an instance is billed per request with concurrency 1, and memory above 512 MiB
  needs 0.5 vCPU ([CPU](https://docs.cloud.google.com/run/docs/configuring/services/cpu)); background work needs
  instance-based billing, so every always-on service with timers is a 1 vCPU instance at $0.000018 a vCPU-second (Tier 1,
  [pricing](https://cloud.google.com/run/pricing)). There is no init container; a migration is a Cloud Run job, which
  takes no image override, so Control would patch the job before each run
  ([execute jobs](https://docs.cloud.google.com/run/docs/execute/jobs)). A private service admits any internal source of
  the project; restricting it to one caller takes `roles/run.invoker` and an ID token per request
  ([service-to-service](https://docs.cloud.google.com/run/docs/authenticating/service-to-service)), a second
  authentication beside the proxy secret. Domain mapping is a preview, not in europe-west3
  ([custom domains](https://docs.cloud.google.com/run/docs/mapping-custom-domains)), so a load balancer is needed anyway.
  Images must be `linux/amd64` ([container contract](https://docs.cloud.google.com/run/docs/container-contract)).
  Newer features were weighed and change none of this: sidecars with a startup order wait for the other container's
  health check, not for it to exit, so they are no run-to-completion init container; volume mounts and Direct VPC
  egress do not narrow who reaches an internal-ingress service.
- **What the Cloud Run figure assumes.** About $300 a month bills all six services instance-based at 1 vCPU. The two
  Caddy proxies keep no timers and could bill request-based at 1 vCPU, which brings it nearer $200 plus their request
  time; the conclusion stands.
- **GKE Autopilot (chosen).** Pods from 50m CPU and 52 MiB with bursting (250m and 512 MiB without), CPU to memory
  between 1:1 and 1:6.5, billed per second on requests
  ([resource requests](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-resource-requests)): at
  US list prices $0.0445 a vCPU-hour and $0.0049225 a GiB-hour ([pricing](https://cloud.google.com/kubernetes-engine/pricing)).
  The cluster fee ($0.10 an hour) is covered by a $74.40 monthly credit per billing account, which pays for exactly
  one zonal or Autopilot cluster; a second installation on the same billing account pays it. Dataplane V2 and
  NetworkPolicy enforcement are on by default, Workload Identity Federation is always on
  ([feature comparison](https://docs.cloud.google.com/kubernetes-engine/docs/resources/autopilot-standard-feature-comparison)).
  SLA: 99.95 % for the control plane, 99.9 % for pods spread across zones
  ([SLA](https://cloud.google.com/kubernetes-engine/sla)).
- **What Autopilot costs in operation.** Auto-upgrade is on and cannot be turned off; a maintenance window and
  exclusions of at most 90 days steer it, and an emergency upgrade can come outside the window
  ([maintenance](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/maintenance-windows-and-exclusions)). An
  upgrade evicts pods, so a one-replica service restarts briefly, as a Zerops container does on a platform update.
  Autopilot refuses privileged pods and host paths
  ([security](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/autopilot-security)), which rules out
  building images in the cluster; Cloud Build does it.
- **GKE Standard and Compute Engine (rejected).** Nodes to size and patch, for nothing Fabrika needs.

### Build: Cloud Build and Artifact Registry

`builds.create` with a `storageSource` (a `.zip` or a `.tar.gz` in Cloud Storage, pinned by generation) builds the
rendered `Dockerfile` and returns the image digest
([builds](https://docs.cloud.google.com/build/docs/api/reference/rest/v1/projects.builds)); the default pool's
`e2-standard-2` costs $0.006 a build-minute after 2,500 free minutes a month
([pricing](https://cloud.google.com/build/pricing)). There are no ARM workers on the default pool, and none are needed:
the image is `linux/amd64`. Artifact Registry keeps the images ($0.10 a GiB-month, 0.5 GiB free) with cleanup policies.
"Deploy from source" was rejected because it hides the digest the run checkpoint records.

The source arrives through a **resumable upload session** that Control opens with its own token: chunks of a multiple of
256 KiB (Google recommends at least 8 MiB) with `Content-Range: bytes X-Y/*`, the last one naming the total; a `308`
answer carries the range received, and the next chunk resumes from it
([resumable uploads](https://docs.cloud.google.com/storage/docs/performing-resumable-uploads),
[streaming](https://docs.cloud.google.com/storage/docs/streaming-uploads)). This is shared prerequisite N2's part
writer. A V4 signed URL with chunked transfer encoding is not documented, so it is not used.

### Migrations: a Job before the rollout

Control creates a Job in the application's namespace with the new image and `fabrika/migrate.generated.sh`, the
provisioning credential in a Secret only the Job mounts, waits for it to complete, then patches the Deployment. The Job
runs once per deploy; an init container would run on every pod start and on every eviction an upgrade causes. A failed
Job fails the run before the Deployment changes.

### Deploy and rollback

A rolling update with `maxUnavailable: 0` keeps the old ReplicaSet serving until a new pod passes its readiness probe
(the contract's health endpoint). Control polls the Deployment's `observedGeneration` and conditions; a rollout past its
`progressDeadlineSeconds` fails the run. Kubernetes does not roll back by itself: on a failed rollout Control writes the
previous pod template back, which is the circuit breaker ECS has built in. Cancellation never implies rollback
(ADR-0044).

### PostgreSQL: Cloud SQL Enterprise

- **Cloud SQL for PostgreSQL 18 (the default version), Enterprise edition, `db-custom-1-3840` (chosen).**
  PostgreSQL 16 and later default to Enterprise Plus in the API, so the edition is set explicitly
  ([instance settings](https://docs.cloud.google.com/sql/docs/postgres/instance-settings)). One vCPU and 3.75 GB
  give 100 connections ([flags](https://docs.cloud.google.com/sql/docs/postgres/flags)); about $49 a month plus
  $0.17 a GB-month of SSD at US prices ([pricing](https://cloud.google.com/sql/pricing)). The `postgres` user is in
  `cloudsqlsuperuser` with `CREATEROLE` and `CREATEDB`
  ([users](https://docs.cloud.google.com/sql/docs/postgres/users)).
- **Backups.** Daily backups kept 1–365 (default 7); point-in-time recovery from the write-ahead log for **up to 7 days
  on Enterprise** and up to 35 on Enterprise Plus
  ([editions](https://docs.cloud.google.com/sql/docs/postgres/editions-intro)). Seven days meets a one-hour recovery point;
  35 days of PITR, as RDS and Azure give on their smallest servers, costs the Enterprise Plus floor (no shared or small
  machines). Say so when an operator asks.
- **TLS.** Set `ENCRYPTED_ONLY`. For `verify-full` the server certificate must name the host: the **shared CA** mode puts
  the instance's DNS name in the certificate's subject alternative names, and the installation resolves that name
  privately ([SSL](https://docs.cloud.google.com/sql/docs/postgres/configure-ssl-instance)). The default per-instance
  CA supports the DNS-name check only for an instance configured with Private Service Connect, which this page chooses;
  the shared CA is kept because it holds on every connectivity type. The Auth Proxy sidecar is not needed once the
  certificate is verified.
- **Private IP** through Private Service Connect (recommended over Private Service Access,
  [private IP](https://docs.cloud.google.com/sql/docs/postgres/private-ip)). Reaching it from Autopilot over private IP
  with `verify-full` was not found documented; first live check.
- **Shared-core tiers (rejected).** `db-g1-small` has no SLA and 50 connections. **AlloyDB (rejected)**: its smallest
  shape is about $110 a month before storage.

### Files: Cloud Storage, XML API first

Fabrika's S3 store uses only what the XML API documents: a HEAD, a streamed PUT (multipart for a large body), a GET
with `If-Match` on the ETag, and a DELETE (`packages/platform-node/src/blob-s3.ts`). The XML API signs with
`AWS4-HMAC-SHA256` and an HMAC key ([signatures](https://docs.cloud.google.com/storage/docs/authentication/signatures)),
so the existing store should work against `https://storage.googleapis.com` with an HMAC key of the installation's
storage service account. That is the first version; `blob-s3.test.ts` against a real bucket is its acceptance.

Two reasons to plan a native adapter on the JSON API with Workload Identity tokens: an HMAC key is a long-lived secret
(at most 10 per service account, no expiry, [HMAC keys](https://docs.cloud.google.com/storage/docs/authentication/hmackeys)),
and an organization policy can forbid HMAC keys outright. Writes with a precondition need `x-goog-if-generation-match`
on Cloud Storage; `If-None-Match: *` and `If-Match` on a write are not documented
([preconditions](https://docs.cloud.google.com/storage/docs/request-preconditions)). Fabrika's store does not send them
today (it checks with a HEAD), so this matters only if the store ever moves to conditional writes. Soft delete keeps
deleted objects 7 days by default (billed); object versioning and lifecycle rules give files their backup.

### Secrets: Kubernetes Secrets

Control writes an application's secrets as a Secret in its namespace, and the Deployment reads them as environment, so
a changed secret takes effect with the next rollout, as on Zerops. Secret Manager ($0.06 a version a month) with the CSI
driver adds a second store and a mount Fabrika does not need. The installation's own secrets (written by the operator's
pipeline) may live in Secret Manager.

### Ingress and TLS: a Gateway with Certificate Manager

The single-cluster Gateway controller is on by default; the class `gke-l7-global-external-managed` with Certificate
Manager serves the installation's hosts, including wildcards
([Gateway API](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/gateway-api),
[managed certificates](https://docs.cloud.google.com/kubernetes-engine/docs/how-to/managed-certs)). One forwarding rule
costs $0.025 an hour (up to five) plus $0.008–0.012 a GiB ([pricing](https://cloud.google.com/load-balancing/pricing)).
The balancer appends `CLIENT_IP,LB_IP` to `X-Forwarded-For` without validating earlier entries
([HTTPS load balancing](https://docs.cloud.google.com/load-balancing/docs/https)), so Caddy reads the second entry
from the right.

### Infrastructure, identity, email, cron, logs

- **Infrastructure.** Terraform with the Google provider in the operator's pipeline renders the installation (project
  services, network, cluster, Cloud SQL, buckets, Artifact Registry, identities). Deployment Manager stopped taking new
  users on 2026-06-30 and shuts down on 2027-06-30
  ([deprecation](https://docs.cloud.google.com/deployment-manager/docs/deprecations)); Infrastructure Manager runs an old
  free Terraform or a paid newer one. Control creates a namespace through the Kubernetes API and Cloud SQL's REST API.
- **Identity.** Control's Kubernetes ServiceAccount holds a ClusterRole that creates namespaces labelled as Fabrika's
  and a Role inside each; its Google Cloud roles (Cloud Build, Artifact Registry, Cloud SQL, Storage) go to the
  ServiceAccount as a Workload Identity principal. IAM conditions on resource names work for Storage, Secret Manager and
  Cloud SQL but not for every service, so the project is the boundary: one project per installation
  ([conditions](https://docs.cloud.google.com/iam/docs/conditions-resource-attributes)). The pipeline signs in through
  Workload Identity Federation for GitHub
  ([deployment pipelines](https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines)).
- **Email.** Outbound port 25 is blocked and Google points to third-party providers
  ([sending mail](https://docs.cloud.google.com/compute/docs/tutorials/sending-mail)); the existing adapters work.
- **Cron.** The serving process keeps cron wakes (N7); a CronJob per job is the fallback.
- **Logs.** Cloud Logging, $0.50 a GiB after 50 GiB a project a month, 30 days in `_Default`.

## Backups and point-in-time recovery

| What                           | Google Cloud                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| PostgreSQL                     | Daily backups kept 1–365; PITR up to 7 days (Enterprise) or 35 (Enterprise Plus)   |
| A restore                      | A clone or restore into an instance; the same repoint step as on AWS               |
| Before a destructive migration | An on-demand backup (`backupRuns.insert`) from `backupBeforeMigrations` (N11)      |
| Files                          | Object versioning and lifecycle rules; soft delete keeps deleted objects 7–90 days |
| The backup view (backlog 212)  | The instance's backup configuration and the list of backup runs                    |

## The checklist

### A. Shared prerequisites

All of [the shared list](cloud-providers.md#the-shared-prerequisites) except N6 in the first version. For Google Cloud
in particular: N2's part writer is a resumable upload session; N3's image is `linux/amd64` and carries the Cloud SQL
server CA; N5's store is the S3 one pointed at the XML API with an HMAC key.

### B. The Google Cloud package, in order

1. **A Kubernetes library** (a neutral package, so AKS or EKS can reuse it): a small client for the Kubernetes API with
   the in-cluster ServiceAccount token, the Deployment, Service, Job, Secret, NetworkPolicy and HTTPRoute renderers,
   rollout polling and the template-revert rollback, with a fake API server for tests.
2. **`packages/provider-gcp/`**: package, `CLAUDE.md`, `tsconfig` files, root reference; `.`, `/cli`, `/installation`.
3. **`src/codecs.ts`**: target (project, region, cluster, namespace, deployment), artifact (the contract only),
   namespace target, checkpoint `{ buildId?, jobName?, generation? }` under 16 KiB.
4. **`src/authoring.ts`**: `defineApp({ id })` read as `gcp`.
5. **`src/google/`**: REST clients for Cloud Build, Cloud Storage, Cloud SQL and Artifact Registry with the
   metadata-server token (Workload Identity), and fakes.
6. **`src/source.ts`**: the resumable-upload part writer for N2.
7. **`src/build.ts`**: `builds.create`, polling, the build log relay, cancel.
8. **`src/deploy.ts`** and **`src/control.ts`**: migration Job, Deployment patch, rollout wait and revert; the
   `ControlProvider` (`deploy`, `reconcile`, `cancel`, `secrets` writing the namespace's Secret, `declaredVariables`,
   `normalizeRegistration`, `lockfileRefusal`, the `backupBeforeMigrations` backup).
9. **`src/namespace/`**: the namespace with its default-deny NetworkPolicy, the proxy Deployment and Service, the
   HTTPRoute and certificate map entry, the application databases in the shared Cloud SQL instance (`cheap`) or an
   instance of their own (`full`), the proxy manifest in the proxy's build (ADR-0045), `claimedResources`.
10. **`src/installation/`**: the Terraform rendered from the installation model (N9), `platform install`, `plan`,
    `deploy`, `upgrade`, `admin`, the federation for the pipeline, Control's ClusterRole, the guide.
11. **`packages/control/src/gcp/`**: the composition root over the Bun host.
12. **Tests**: conformance over the fake Kubernetes API and fake Google APIs, renderer tests, a live suite gated on
    `FABRIKA_LIVE_GCP_*`.
13. **Docs**: `docs/reference/gcp-platform.md`, an ADR (with the Cloud Run rejection), `installing-on-gcp.md`.

## Effort

| Part                                                                                     |    Parity | First usable |
| ---------------------------------------------------------------------------------------- | --------: | -----------: |
| Shared prerequisites ([the comparison](cloud-providers.md#effort)), once for every cloud |     22–35 |        20–33 |
| Kubernetes library: client, renderers, rollout and revert, fake API server               |      8–12 |            7 |
| Provider skeleton, codecs, `defineApp`, conformance harness                              |       3–4 |            3 |
| Google REST clients, token source, fakes                                                 |       3–4 |            3 |
| Build: resumable upload, Cloud Build, Artifact Registry, source maps, log relay          |       3–5 |            3 |
| Deploy: migration Job, rollout, revert, checkpoint, reconcile, cancel                    |       4–7 |            4 |
| Secrets and the managed environment                                                      |       1–2 |            1 |
| Cloud SQL: shared CA, roles, connection budget, backup before migration, restore runbook |       3–5 |            3 |
| Namespaces: namespaces, NetworkPolicy, proxy, Gateway routes, certificates, claims       |      6–10 |  4 (`cheap`) |
| Installation: Terraform, install/deploy/upgrade, RBAC and IAM, federation, guide         |     10–14 |            7 |
| Native Cloud Storage adapter (when HMAC keys are refused), backup view, observability    |       4–6 |            0 |
| Live bring-up, `gcp-platform.md`, ADR                                                    |      8–12 |            6 |
| **Google Cloud package total**                                                           | **53–81** |     **≈ 41** |

## Running cost of one small installation

Read on **2026-11-24**. Google's pricing pages render their tables with JavaScript, and only the default region's (US)
prices could be read; **europe-west3 prices were not verified** and are higher. A month is 730 hours. The workload is
the one of [the comparison](cloud-providers.md#running-cost-of-one-small-installation).

| Item                              | Configuration                                     | Unit price (US)                            |       USD |
| --------------------------------- | ------------------------------------------------- | ------------------------------------------ | --------: |
| GKE Autopilot pods                | 1.75 vCPU, 3.5 GiB requested, always on           | $0.0445/vCPU-h, $0.0049225/GiB-h           |     69.43 |
| GKE cluster fee                   | one Autopilot cluster                             | $0.10/h, covered by the $74.40 credit      |         0 |
| Load balancer                     | one forwarding rule, light traffic                | $0.025/h, $0.008–0.012/GiB                 |     18.50 |
| Cloud SQL                         | Enterprise `db-custom-1-3840`, 30 GB SSD, zonal   | $0.0413/vCPU-h, $0.007/GiB-h, $0.17/GB     |     54.41 |
| Cloud Storage                     | 50 GB Standard, operations                        | from $0.020/GB-month                       |      1.50 |
| Outbound traffic                  | 20 GiB to Europe                                  | first GiB free, then $0.12/GiB             |      2.28 |
| Artifact Registry, Build, Logging | 5 GB of images, a few builds a day, 5 GiB of logs | $0.10/GiB; inside the free minutes and GiB |      0.45 |
| **Total**                         |                                                   |                                            | **≈ 147** |

On Cloud Run the compute line alone would be about $300 for the same services, because each always-on service needs a
full vCPU. A second installation on the same billing account adds the cluster fee, about $73.

## Risks

- **Kubernetes is a surface Fabrika has not driven.** Rollouts without automatic rollback, RBAC, NetworkPolicy and the
  Gateway API are new code paths and new ways to be wrong; the fake API server has to be good.
- **Forced upgrades** restart one-replica services inside the maintenance window, and an emergency upgrade can come
  outside it.
- **Seven days of PITR** on the affordable edition, against 35 on RDS and Azure.
- **Prices in Frankfurt** were not read; the totals here are a floor.
- **The cluster credit** covers one cluster per billing account; a second installation pays the fee.
- The rest is AWS' list: one more provider to keep current, a new security boundary, no faithful local emulator.

## Open questions before any code

- Do the existing S3 store's calls all work against the XML API with an HMAC key (`blob-s3.test.ts` against a bucket)?
- Does `verify-full` hold against Cloud SQL's shared CA over Private Service Connect from Autopilot?
- What are the europe-west3 prices of Autopilot, Cloud SQL and the balancer?
- How does the balancer's `X-Forwarded-For` look at the pod behind a Gateway, and which entry is the client?
- Does an idle Bun pod fit in 0.25 vCPU with bursting, and what does an upgrade's eviction do to a run Control holds
  (the lease survives it; a run in flight is settled by the next owner, ADR-0044)?
