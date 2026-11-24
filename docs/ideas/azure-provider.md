# An Azure provider

**Status of the idea.** Researched on 2026-11-24 from the code at `11e8da5bf` and Microsoft's documentation and Retail
Prices API. Nothing deployed, no Azure subscription touched. Not decided. The prerequisites every cloud shares, and how
Azure compares with AWS and Google Cloud, are in [Fabrika on the big three clouds](cloud-providers.md); this page holds
what is true of Azure.

## The short answer

Azure fits Fabrika's shape better than AWS in one respect and worse in one. **Better:** Azure Container Apps is closer
to Zerops than ECS is. One Container Apps environment is one private network with built-in ingress, TLS and free
managed certificates, internal-only apps, revisions that take traffic only once their probes pass, and jobs for
one-off and scheduled runs. A namespace maps onto an environment as it maps onto a project on Zerops, and there is no
balancer to pay for. **Worse:** Blob Storage has no S3 API, so the platform and the application runtime need a second
object store implementation (shared prerequisite N6), and Container Apps runs `linux/amd64` only.

Effort: the shared prerequisites (about 22–35 person-days, once for every cloud), then about 39 for a first usable
Azure provider (the Blob Storage adapter included) and 48–76 for parity. A small installation costs about $70–160 a month,
depending on how much of the time its containers are idle.

## How Azure maps onto the provider contract

| Fabrika concept                           | Zerops today                                                 | Azure                                                                                                    | Rejected                                            |
| ----------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Installation (one cloud, ADR-0011)        | One Zerops project for the platform                          | One resource group in one region, a VNet, one Container Apps environment for the platform                | A subscription per installation (later)             |
| Long-running service                      | Zerops runtime service, `alpine/bun@1.3`                     | A container app on the Consumption profile of a workload-profiles environment                            | App Service, AKS, AKS Automatic, Dedicated profiles |
| Build (ADR-0003: no runner)               | Zerops build container, triggered over REST                  | ACR Tasks `ScheduleRun` of a `Dockerfile` on an uploaded tar.gz; ACR Basic; deployed by digest           | Container Apps cloud build (preview API only)       |
| Source transport (ADR-0029)               | Control streams the GitHub tarball to the app version upload | The same stream into the SAS URL `listBuildSourceUploadUrl` returns, as `Put Block` and `Put Block List` | One `Put Blob` (needs a length)                     |
| Deploy and activation                     | `build-and-deploy`, readiness check gates activation         | PUT the container app; in single revision mode traffic moves only once the new revision's probes pass    |                                                     |
| Migrations                                | `run.initCommands` on every container start                  | A manual Container Apps job with the new image runs `migrate` once, before the app's PUT                 | An init container (runs per replica and restart)    |
| Run checkpoint and recovery (ADR-0044)    | `{ appVersionId, triggered }`                                | `{ runId, jobExecution, revisionSuffix }`, each recorded before the call that needs it                   |                                                     |
| Secrets (ADR-0004)                        | Sensitive service variables                                  | Container app secrets, written by Control into the app resource with each deploy                         | Key Vault references for application secrets        |
| Managed environment                       | Service variables plus literals in the descriptor            | The container's `env`, literal or `secretRef`, written per run                                           |                                                     |
| Deployment namespace (ADR-0014)           | One Zerops project with its own proxy                        | One Container Apps environment in its own subnet, its proxy app with external ingress                    | Several namespaces in one environment               |
| Private network trust (ADR-0022 rule 5)   | Everything in a project reaches every port                   | Applications have internal ingress only: reachable inside their environment, not from outside            |                                                     |
| Public entry and TLS                      | Project L7 balancer, Zerops subdomain or custom domain       | The proxy app's external ingress, custom domains with free managed certificates                          | Front Door, Application Gateway                     |
| PostgreSQL                                | Managed `postgresql:single@18` / `ha@18` service             | Azure Database for PostgreSQL Flexible Server 18, Burstable `B1ms`/`B2s`; General Purpose for HA         | Cosmos DB for PostgreSQL, a VM                      |
| Object storage                            | Zerops object storage (MinIO), static keys                   | Blob Storage (StorageV2, hot, LRS or ZRS) through a native adapter, Entra tokens of the managed identity | NetApp Files object API, an S3 gateway of our own   |
| Outbound email (ADR-0019)                 | An adapter (Postmark, Resend, …) or Control's relay          | The same adapters unchanged                                                                              | Azure Communication Services Email (retiring)       |
| Cron (`run.crontab`)                      | Zerops crontab in the container                              | The serving process keeps cron wakes (shared prerequisite N7)                                            | A scheduled job per cron job (fallback)             |
| Service logs                              | Zerops project log service                                   | Log Analytics (5 GB a month free), the Basic plan for the console log table                              |                                                     |
| Installation tooling (ADR-0025, ADR-0027) | `platform install/deploy/upgrade --provider=zerops`          | Bicep compiled to an ARM template, applied as a deployment stack with deny settings                      | Terraform (a toolchain in Control)                  |
| Sidecar pipeline credential               | A Zerops integration token in a GitHub Environment           | A federated credential on a user-assigned managed identity (GitHub OIDC)                                 | A client secret in a GitHub secret                  |

## The service choices

### Compute: Container Apps on the Consumption profile

- **Container Apps (chosen).** A workload-profiles environment (the default; consumption-only environments are labelled
  legacy) with only the Consumption profile has no fixed charge: the $0.10 an hour management meter applies to the
  Dedicated plan, private endpoints and planned maintenance
  ([billing](https://learn.microsoft.com/en-us/azure/container-apps/billing)). Sizes start at 0.25 vCPU and 0.5 GiB
  ([containers](https://learn.microsoft.com/en-us/azure/container-apps/containers)), so Fabrika's small containers fit
  as they do on Zerops. In single revision mode, the default, traffic moves to a new revision only after it is
  provisioned and its startup and readiness probes pass, and a failed revision leaves traffic where it was
  ([revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions)): the readiness gate of Zerops'
  activation, built in. A custom VNet needs a dedicated subnet of at least /27
  ([networking](https://learn.microsoft.com/en-us/azure/container-apps/networking)).
- **The namespace boundary is an environment.** An app with internal ingress is reachable from every app in its
  environment, and an environment-level HTTP route could still reach it from outside
  ([ingress](https://learn.microsoft.com/en-us/azure/container-apps/ingress-overview)). So each namespace gets its own
  environment, as each gets its own project on Zerops, and Control never creates an environment HTTP route. Inside a
  namespace the proxy secret authenticates the hop (ADR-0022 rule 5), as on Zerops.
- **AKS and AKS Automatic (rejected).** AKS Automatic's hosted control plane alone is $0.16 an hour, about $117 a month,
  before any node ([AKS Automatic](https://learn.microsoft.com/en-us/azure/aks/intro-aks-automatic)), and a cluster
  is a job of its own. If an operator mandates Kubernetes, the answer is a Kubernetes provider shared by AKS, EKS and
  GKE ([the comparison](cloud-providers.md#one-kubernetes-provider-instead)).
- **App Service (rejected).** Billed per plan, not per container, with no counterpart of an environment's private
  network or of jobs; not researched further.
- **Dedicated workload profiles (rejected for small installations).** A D4 profile is about $225 a month plus the
  management charge.
- **`linux/amd64` only.** Container Apps runs no ARM image, so the image recipe (N3) builds for amd64 here.

### Build: ACR Tasks

- **ACR Tasks (chosen).** `listBuildSourceUploadUrl` returns a blob SAS URL and a relative path, and `ScheduleRun` (a
  `DockerBuildRequest` with `platform` and a timeout of 300–28,800 s) builds from that path
  ([upload URL](https://learn.microsoft.com/en-us/rest/api/container-registry-tasks/registries/get-build-source-upload-url),
  [schedule run](https://learn.microsoft.com/en-us/rest/api/container-registry-tasks/registries/schedule-run)). A tar.gz
  is what `az acr build` uploads. A task vCPU-second costs $0.0001 after 6,000 free seconds a month.
- **The upload is a sequence of blocks.** `Put Blob` and every `Put Block` need a `Content-Length`; a stream of unknown
  length goes as fixed-size `Put Block` calls and one `Put Block List`, all under the same SAS
  ([Put Block](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block),
  [Put Block List](https://learn.microsoft.com/en-us/rest/api/storageservices/put-block-list)). The block size limit
  depends on the service version the request runs at, which for a SAS is its `sv` unless the request sends
  `x-ms-version` ([versioning](https://learn.microsoft.com/en-us/rest/api/storageservices/versioning-for-the-azure-storage-services));
  sending the header, or blocks of at most 4 MiB, keeps it safe. This is shared prerequisite N2's part writer.
- **Never hand ACR a credentialed URL.** An absolute `sourceLocation` may be logged in ACR's diagnostics with its token
  ([tasks overview](https://learn.microsoft.com/en-us/azure/container-registry/container-registry-tasks-overview)), so
  Control uploads the archive itself and never passes GitHub's tarball URL.
- **ACR Basic** ($0.1666 a day). Private endpoints need Premium ($1.6666 a day); a first installation pulls over the
  public endpoint with the managed identity. ACR Tasks runs are paused on free-credit subscriptions, so a trial
  subscription cannot build.
- **Container Apps cloud build (rejected).** Its API exists only as `2023-11-02-preview`.

### Migrations: a manual job before the revision

A manual Container Apps job, started with a template override that names the new image and runs
`fabrika/migrate.generated.sh` with the provisioning credential, migrates once; Control polls the execution, then PUTs
the container app with a deterministic revision suffix and polls `latestReadyRevisionName`
([jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs),
[container apps REST](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update)).
The provisioning credential lives only in the job, never in the application's container. An init container also exists,
but it runs per replica, on every restart and scale-out. Starting a job amounts to reading its secrets, so the right to
start it stays Control's.

### PostgreSQL: Flexible Server

- **Azure Database for PostgreSQL Flexible Server 18 (chosen).** PostgreSQL 18 is GA, minor 18.6
  ([versions](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-supported-versions)).
  Backups with point-in-time restore, retention 7–35 days, backup storage free up to the provisioned storage,
  geo-redundant backup selectable only at creation, long-term retention through Azure Backup
  ([backup](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore)). The server
  admin is `NOSUPERUSER` with `CREATEDB` and `CREATEROLE`
  ([users](https://learn.microsoft.com/en-us/azure/postgresql/security/security-manage-database-users)), which is what
  `provisionPostgresRoles` needs.
- **Sizes.** `B1ms` ($0.0199 an hour, 50 connections) is the floor; `B2s` ($0.0796, 429 connections) is the sensible
  size for three services and an application
  ([limits](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/concepts-limits)). Burstable servers
  have no high availability and Microsoft does not recommend them for production
  ([compute](https://learn.microsoft.com/en-us/azure/postgresql/compute-storage/concepts-compute)); HA needs a General
  Purpose server with a billed standby.
- **Unresolved:** the region table shows Burstable as unavailable in Germany West Central
  ([overview](https://learn.microsoft.com/en-us/azure/postgresql/overview)) while the price list has `B1ms` and `B2s`
  meters there. Check before relying on it; West Europe has them.
- **TLS** is enforced by default; the trust roots are DigiCert Global Root G2 and Microsoft RSA Root CA 2017, and the
  docs warn that full verification may fail with private DNS, where they suggest `verify-ca`
  ([TLS](https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls)). Fabrika's URL says
  `sslmode=verify-full&sslrootcert=<bundle of both roots>` (N4); with VNet integration the server's name is in the
  private DNS zone, so `verify-full` should hold. First live check.
- **Networking.** VNet integration (a delegated subnet) or a private endpoint, fixed at creation; Microsoft recommends
  the private endpoint ($7.30 a month); VNet integration costs nothing and is enough for one installation
  ([private link](https://learn.microsoft.com/en-us/azure/postgresql/network/concepts-networking-private-link)).
- **Entra authentication** with the managed identity's tokens exists; Fabrika keeps its derived passwords (ADR-0017),
  which work the same on every cloud.

### Files: Blob Storage through a native adapter

Blob Storage exposes REST, SFTP and NFS 3.0 and no S3 API
([introduction](https://learn.microsoft.com/en-us/azure/storage/blobs/storage-blobs-introduction)); Microsoft's only
S3-compatible offer is Azure NetApp Files' object API, with a 1 TiB pool floor, and Microsoft supports no S3 gateway.
So Fabrika implements `BlobStore` and `FileObjectStore` over the Blob REST API (shared prerequisite N6): bearer tokens
for `https://storage.azure.com/` from the managed identity
([Entra](https://learn.microsoft.com/en-us/rest/api/storageservices/authorize-with-azure-active-directory)),
`If-None-Match: *` and `If-Match` on writes and reads
([conditional headers](https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations)),
and blocks for a stream. Data protection: soft delete (1–365 days), versioning, and point-in-time restore of block blobs
(needs soft delete, versioning and change feed,
[point-in-time restore](https://learn.microsoft.com/en-us/azure/storage/blobs/point-in-time-restore-overview)). Fabrika
never hands a storage URL to a browser, so no SAS is needed for applications.

### Secrets: in the container app, not Key Vault

Container app secrets change without a new revision and take effect at the next revision or restart; Key Vault
references follow a new secret version within 30 minutes and restart active revisions on their own
([secrets](https://learn.microsoft.com/en-us/azure/container-apps/manage-secrets)). Fabrika's rule is that a changed
secret takes effect with the next deploy (ADR-0004), so Control writes application secrets into the app resource with
each deploy. Key Vault ($0.03 per 10,000 operations) holds the installation's own secrets, which the operator's
pipeline writes, and the Control vault's key-encryption key.

### Ingress and TLS: the built-in ingress

The proxy app's external ingress serves the installation's hosts with free managed certificates; the CNAME must point
at the app directly and a CAA record must admit DigiCert
([managed certificates](https://learn.microsoft.com/en-us/azure/container-apps/custom-domains-managed-certificates)).
The ingress appends to `X-Forwarded-For`, and only the rightmost address is Azure's, so Caddy trusts exactly that hop.
HTTP requests time out after 240 seconds. Front Door Standard ($35 a month before traffic) and Application Gateway v2
($0.20 an hour Standard) add nothing a small installation needs.

### Infrastructure: Bicep as a deployment stack, ARM PUTs from Control

The operator's pipeline deploys the installation's Bicep as a deployment stack with deny settings
([deployment stacks](https://learn.microsoft.com/en-us/azure/azure-resource-manager/bicep/deployment-stacks)), with
what-if as `platform plan`. Control creates a namespace with plain, idempotent ARM PUTs (the environment, its proxy, the
application's database), each a checkpoint it can resume; it is excluded from the stack's deny settings for the
namespace resources it owns.

### Email, cron, logs, identity

- **Email.** Azure Communication Services is retired as a standalone service on 2028-09-30, Email included, which is
  in maintenance mode now ([retirement](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide)).
  Do not build an adapter for it; the existing adapters work unchanged.
- **Cron.** The serving process keeps cron wakes (N7). A scheduled Container Apps job (five-field cron in UTC, billed
  only while running) is the fallback, one job resource per cron job.
- **Logs.** Log Analytics with the first 5 GB a month free, or the Basic plan for `ContainerAppConsoleLogs`
  ([log options](https://learn.microsoft.com/en-us/azure/container-apps/log-options)).
- **Identity.** Control acts as a user-assigned managed identity with roles scoped to the installation's resource
  group and the namespaces' resource groups; the sidecar workflow signs in through a federated credential on a
  user-assigned managed identity ([GitHub OIDC](https://learn.microsoft.com/en-us/azure/developer/github/connect-from-azure-openid-connect)).

## Backups and point-in-time recovery

| What                           | Azure                                                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| PostgreSQL                     | PITR within 7–35 days, backup storage free up to the provisioned storage; geo-redundant backup at creation |
| A restore                      | Creates a new server: Fabrika needs the same repoint step as on AWS                                        |
| Before a destructive migration | An on-demand backup of the server from `backupBeforeMigrations` (N11); verify the API on a live server     |
| Files                          | Soft delete, versioning and point-in-time restore of block blobs; immutable storage for legal holds        |
| The backup view (backlog 212)  | The server's backup retention and earliest restore time from ARM                                           |

## The checklist

### A. Shared prerequisites

All of [the shared list](cloud-providers.md#the-shared-prerequisites), N6 included. For Azure in particular: N2's part
writer is `Put Block`/`Put Block List` under the ACR upload SAS with an explicit `x-ms-version`; N3's image is
`linux/amd64` with the two Azure roots; N5's credential source is an Entra token from the managed identity endpoint; N6
is the Blob adapter itself.

### B. The Azure package, in order

1. **`packages/provider-azure/`**: package, `CLAUDE.md`, `tsconfig` files, root reference; `.`, `/cli`,
   `/installation`.
2. **`src/codecs.ts`**: target (subscription, resource group, environment, app), artifact (the contract only),
   namespace target, checkpoint `{ runId?, jobExecution?, revisionSuffix? }` under 16 KiB.
3. **`src/authoring.ts`**: `defineApp({ id })` read as `azure`.
4. **`src/arm/`**: a small ARM REST client (JSON over HTTPS, `Azure-AsyncOperation` polling) with an Entra token
   source, and fakes. No SDK is needed: every call is a JSON PUT, GET or POST.
5. **`src/source.ts`**: the block writer for N2 over the upload SAS.
6. **`src/build.ts`**: `listBuildSourceUploadUrl`, `ScheduleRun` with the rendered `Dockerfile`, run polling, the
   run log relay, cancel.
7. **`src/app.ts`**: the container app resource (image by digest, the probes on the contract's health endpoint,
   `env` and `secrets`, internal ingress, min replicas 1, single revision mode, a deterministic revision suffix).
8. **`src/migrate.ts`**: the migration job (manual trigger) and one execution per deploy with the template override.
9. **`src/deploy.ts`** and **`src/control.ts`**: the run's steps and the `ControlProvider` (`deploy`, `reconcile`,
   `cancel`, `secrets` writing the app's secrets, `declaredVariables`, `normalizeRegistration`, `lockfileRefusal`,
   the `backupBeforeMigrations` backup).
10. **`src/namespace/`**: the environment in its own subnet, the proxy app with external ingress and the managed
    certificates of its hosts, the application databases in the shared server (`cheap`) or a server of their own
    (`full`), the proxy manifest in the proxy's build (ADR-0045), `claimedResources` from ARM.
11. **`src/installation/`**: the Bicep or ARM template from the installation model (N9), `platform install`, `plan`
    (what-if), `deploy`, `upgrade`, `admin`, the federated identity, Control's role assignments, the sidecar workflow,
    the guide.
12. **`packages/control/src/azure/`**: the composition root over the Bun host.
13. **Tests**: conformance over a fake ARM, renderer tests, a live suite gated on `FABRIKA_LIVE_AZURE_*`.
14. **Docs**: `docs/reference/azure-platform.md`, an ADR, `installing-on-azure.md`.

## Effort

| Part                                                                                           |    Parity | First usable |
| ---------------------------------------------------------------------------------------------- | --------: | -----------: |
| Shared prerequisites ([the comparison](cloud-providers.md#effort)), once for every cloud       |     22–35 |        20–25 |
| The Blob Storage adapter (N6), in the platform and the application runtime                     |       4–6 |            4 |
| Provider skeleton, codecs, `defineApp`, conformance harness over a fake ARM                    |       3–4 |            3 |
| ARM client, token source, fakes                                                                |       2–4 |            2 |
| Build: block upload, ACR Tasks, source maps, log relay                                         |       3–5 |            3 |
| Deploy: container app, migration job, revisions, checkpoint, reconcile, cancel                 |      6–10 |            6 |
| Secrets and the managed environment                                                            |       1–2 |            1 |
| PostgreSQL Flexible Server: roles, connection budget, backup before migration, restore runbook |       3–5 |            3 |
| Namespaces: an environment per namespace, the proxy, certificates, claims                      |      6–10 |  4 (`cheap`) |
| Installation: Bicep, install/deploy/upgrade, identities and roles, OIDC sidecar, guide         |     10–15 |            7 |
| Backup view, observability                                                                     |       2–3 |            0 |
| Live bring-up, `azure-platform.md`, ADR                                                        |      8–12 |            6 |
| **Azure package total**                                                                        | **48–76** |     **≈ 39** |

## Running cost of one small installation

List prices read on **2026-11-24** from the Azure Retail Prices API, Germany West Central, pay-as-you-go. A month is
730 hours. The workload is the one of [the comparison](cloud-providers.md#running-cost-of-one-small-installation).

| Item                       | Configuration                                  | Unit price                                |          USD |
| -------------------------- | ---------------------------------------------- | ----------------------------------------- | -----------: |
| Container Apps vCPU        | 1.75 vCPU always on, minus 180,000 free vCPU-s | $0.000024/s active, $0.000003/s idle      |       13–106 |
| Container Apps memory      | 3.5 GiB always on, minus 360,000 free GiB-s    | $0.000003/GiB-s                           |        26.51 |
| PostgreSQL Flexible Server | `B1ms` (`B2s`: +43.58), 32 GiB storage         | $0.0199/h, $0.137/GB-month                |        18.91 |
| Blob Storage               | 50 GB hot LRS, operations                      | $0.0196/GB-month                          |         2.00 |
| ACR Basic and tasks        | one registry, about 10 build minutes a day     | $0.1666/day, $0.0001/vCPU-s after 6,000 s |         6.27 |
| Log Analytics              | 5 GB                                           | first 5 GB free                           |            0 |
| Key Vault                  | about 100,000 operations                       | $0.03 per 10,000                          |         0.30 |
| Outbound traffic           | 20 GB, inside the free 100 GB                  | $0.087/GB beyond                          |            0 |
| **Total**                  |                                                |                                           | **≈ 67–160** |

The range is the idle rate: a replica at its minimum that serves no request and uses under 0.01 vCPU is billed at an
eighth of the active vCPU rate. Whether an idle Bun process with its timers stays under that line is a live
measurement; the high end assumes it never does. With `B2s` the database is sized for the connections and the total is
about $110–205. HA (a General Purpose server with a zone-redundant standby, doubled containers) was about $456 a month
on 2026-11-11 and was not re-priced.

## Risks

- **The second object store.** Every file and log path runs through an implementation only Azure uses, so its bugs
  surface only there. The conformance tests of the storage ports have to hold it to the S3 one.
- **The idle rate is a guess until measured.** The bill can double between "idle" and "active".
- **Burstable in Germany West Central** is unclear (above), and Burstable is not recommended for production.
- **Managed certificates need a direct CNAME**: an operator who fronts the hosts with another CDN must bring its own
  certificate.
- The rest is AWS' list: one more provider to keep current, a new security boundary (Control's role assignments), no
  faithful local emulator, slower feedback.

## Open questions before any code

- Can `B1ms`/`B2s` be created in Germany West Central?
- Does `verify-full` hold against a VNet-integrated Flexible Server with the private DNS zone?
- Which `sv` does the ACR upload SAS carry, and does ACR accept GitHub's single top-level folder (the transport strips
  it today, so it should not matter)?
- Does an idle Bun process qualify for the idle rate?
- How many vCPUs is an ACR task run billed for?
