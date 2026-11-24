# Fabrika on the big three clouds

**Status of the idea.** Researched on 2026-11-24 from the code at `11e8da5bf` and each vendor's official documentation
and price lists. Nothing deployed, no cloud account touched. Not decided. Each cloud has its own page with the mapping,
the reasons and the checklist: [AWS](aws-provider.md), [Azure](azure-provider.md), [Google Cloud](gcp-provider.md).
This page puts them side by side and lists the provider-neutral work all three need first.

## Side by side

| Concern                         | AWS                                                       | Azure                                                   | Google Cloud                                                 |
| ------------------------------- | --------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| Compute                         | ECS on Fargate (ARM64)                                    | Container Apps, Consumption profile (amd64)             | GKE Autopilot (amd64)                                        |
| Rejected compute                | Express Mode, App Runner, EKS                             | App Service, AKS, Dedicated profiles                    | Cloud Run (1 vCPU floor, no init containers), GKE Standard   |
| Smallest always-on unit         | 0.25 vCPU, 0.5 GB                                         | 0.25 vCPU, 0.5 GiB                                      | 0.25 vCPU, 0.5 GiB (50m with bursting)                       |
| A namespace is                  | A CloudFormation stack, its security groups               | A Container Apps environment in its own subnet          | A Kubernetes namespace with a default-deny NetworkPolicy     |
| Only the proxy reaches apps     | Security group rules                                      | Internal ingress inside the environment                 | NetworkPolicy                                                |
| Build                           | CodeBuild (`NO_SOURCE`, fetches the tar.gz), ECR          | ACR Tasks on the uploaded tar.gz, ACR Basic             | Cloud Build from Cloud Storage, Artifact Registry            |
| Source upload of unknown length | S3 multipart upload                                       | `Put Block` and `Put Block List` under one SAS          | A resumable upload session                                   |
| Migrations                      | Init container (`dependsOn: SUCCESS`); a pause hook later | A manual job before the revision                        | A Job before the rollout                                     |
| Activation gate                 | Health check, circuit breaker rolls back                  | Single revision mode: probes pass or traffic stays      | Readiness probe; Control reverts a failed rollout            |
| PostgreSQL                      | RDS 18, `db.t4g.small`                                    | Flexible Server 18, `B1ms`/`B2s`                        | Cloud SQL 18 Enterprise, `db-custom-1-3840`                  |
| Point-in-time recovery          | Up to 35 days                                             | 7–35 days                                               | Up to 7 days (35 on Enterprise Plus)                         |
| Database TLS                    | `verify-full`, RDS global bundle                          | `verify-full`, DigiCert G2 + Microsoft RSA 2017         | `verify-full` with the shared CA mode                        |
| Object storage                  | S3 (the existing store)                                   | Blob Storage, a native adapter (no S3 API)              | Cloud Storage XML API with an HMAC key; native adapter later |
| Secrets                         | Parameter Store `SecureString`                            | Container app secrets                                   | Kubernetes Secrets                                           |
| Public entry and TLS            | One ALB, ACM                                              | Built-in ingress, free managed certificates             | Gateway, Certificate Manager, one forwarding rule            |
| Infrastructure                  | CloudFormation (installation and namespaces)              | Bicep deployment stack; ARM PUTs from Control           | Terraform; Kubernetes and REST APIs from Control             |
| Pipeline credential             | GitHub OIDC to an IAM role                                | Federated credential on a managed identity              | Workload Identity Federation                                 |
| Email                           | Existing adapters; SES optional                           | Existing adapters (ACS Email retiring 2028)             | Existing adapters (no Google service)                        |
| Small installation / month      | ≈ $151                                                    | ≈ $67–160                                               | ≈ $147 (US prices; Frankfurt higher)                         |
| Effort after the shared work    | ≈ 39 first usable, 51–78 parity                           | ≈ 39 first usable (blob adapter included), 48–76 parity | ≈ 41 first usable, 53–81 parity                              |

## The shared prerequisites

Checked against the code at `11e8da5bf`. Each lands in Control, a neutral library or the framework, and every cloud
above uses it. Ordered by what blocks a first deploy on any of them.

### N1. A source archive that binds no repository descriptor (S, all three)

`createGitHubSource` takes one `SourceDescriptorRule` (`packages/control/src/github/source/index.ts`), and every archive
pass hashes that file and fails with `descriptor_missing` when the commit lacks it (`archive.ts`). On Zerops the rule is
the root `zerops.yaml`, whose digest the artifact registers (ADR-0043). A provider that renders the whole build from
`contractRecipe` has no such file. The rule becomes optional per composition: without it the pass hashes nothing and
`descriptorSha256` is absent from the resolution and the summary; the Zerops composition keeps its rule unchanged. About
60 lines across Control, `provider-zerops` and `local-stack` name the digest.

### N2. An upload in parts (M, all three)

`SourceTransport.put` (`packages/control/src/github/source/transport.ts`) sends the gzip stream as one `PUT` with
`duplex: 'half'`, so the request carries no `Content-Length`. The destination is already injected
(`isUploadDestination`); what does not travel is the request. S3 refuses an object without a length and takes an unknown
length only as a multipart upload; Azure's `Put Blob` and `Put Block` each need a length; Cloud Storage takes a stream
through a resumable session. So the transport gains a second target besides today's single streamed `PUT` (Zerops and
the dev sandboxes): it cuts the gzip stream into parts of a fixed size, holds at most one in memory per upload, and
hands each to the provider's part writer (S3 `UploadPart`, Azure `Put Block`, a resumable chunk), then asks it to
finish. The archive's validation verdict keeps precedence over a network failure, as today.

### N3. A container image rendered from `contractRecipe` (M, all three)

`contractRecipe` (`packages/app/src/build-recipe.ts`, `@fabrika/app/build`) is already data: install, the tests, `tsc`,
the checker, the generated entry, the migrate script, the start script and the jobs. Only Zerops renders it
(`packages/provider-zerops/src/execution.ts`). One renderer of a `Dockerfile` beside it (a build stage running `build`, a
runtime stage with the source root and the generated scripts, a Bun base pinned by digest to `.bun-version`, a platform
argument and a CA bundle) serves every container cloud. Three details are not data yet:

- The build's schema check installs PostgreSQL with `sudo apk add` (`buildSchemaChecksCommand`); a Docker build runs as
  root without `sudo`. The command needs a form without it, or the renderer uses `schemaChecks: 'init'`.
- The source-map step needs the release-scoped upload bearer (`artifactUpload`). In an image build it must arrive as a
  build secret, never a build argument, which lands in the image's history.
- The image serves both steps: the provider runs the migrate script as its cloud's one-off step (an init container, a
  job) and the start script as the container's command.

### N4. PostgreSQL over TLS with the cloud's CA (S, all three)

All three managed databases enforce or offer TLS; the Zerops URLs say `sslmode=disable`. Measured on 2026-11-24 with Bun
1.4.4 against a local PostgreSQL 18 whose certificate a private CA signed: `Bun.SQL` with `sslmode=verify-full`
refuses the server without the CA, accepts it with `sslrootcert=<path>` in the URL, with `tls: { ca }`, or with the CA
in `NODE_EXTRA_CA_CERTS`, and refuses a host the certificate does not name. Every connection the platform opens takes
the URL as given (`PostgresDatabase.connect`, `openPostgres`), and the derived role URLs keep its query
(`postgresRoleUrl`, `applicationRuntimeUrl`). So no client code changes: a provider writes
`?sslmode=verify-full&sslrootcert=<bundle>` and the image carries the bundle (N3). What is left is a test that pins it.

### N5. Object storage from one parsed connection, with rotating credentials (M, all three)

Three places build the S3 client from their own variables: Control's run logs (`packages/control/src/bun/runtime.ts`,
`blobStore`), Operations' payloads (`packages/operations/src/node/runtime.ts`) and the application's files
(`openFileStorage`, `packages/app/src/bun.ts`). Each takes a static key pair; the application's hard-codes
`region: 'us-east-1'` and path-style addressing, which S3 refuses to sign against a bucket in another region. The ports
are already neutral (`BlobStore`, `FileObjectStore`, `packages/platform/src/ports.ts`). Needed: one parser of a storage
connection (endpoint, region, addressing, credential source) used by the three; a credential source that refreshes (the
ECS container credentials endpoint, an Entra or Google token); new optional variables beside today's, which stay as
they are, because the application's are platform protocol (ADR-0062).

### N6. A native object store (M, Azure; Google Cloud later)

Blob Storage speaks no S3, so Azure needs `BlobStore` and `FileObjectStore` over the Blob REST API in `platform-node`,
chosen by the application runtime from N5's connection. The store's own calls are few: `FileObjectStore.write` checks
for an existing key with a HEAD and writes, `readVersion` sends `If-Match` on a GET, plus a DELETE. A Cloud Storage
adapter on the JSON API is the same work again, needed only where HMAC keys are refused.

### N7. Cron without a container crontab (M, all three)

On Bun the schedule is the container's crontab: `contractRecipe` lists the `jobs`, Zerops renders them into
`run.crontab`, and the framework keeps no cron wake on Bun (`packages/app/src/jobs/runner.ts`, "On Bun, where crontab
runs the schedule"). The serving process already runs a `WakeTimer` for kicks and claims, and the Cloudflare object
already keeps one cron wake per job under the job leases. Letting the Bun serving process keep cron wakes the same way,
switched on by an additive framework variable so older applications keep their crontab, gives every container cloud its
schedule with no scheduler resource, no cold start and no extra identity. A cloud scheduler stays the fallback.

### N8. A provider skeleton and the conformance suite (S, all three)

`@fabrika/provider-contract/conformance` exists and both providers pass it. A third provider needs a package with the
`.`, `/cli` and `/installation` subpaths, its codecs, `defineApp`, a fake cloud for the harness, and a composition root
`packages/control/src/<cloud>/` over the neutral Bun host (`src/bun/`, `BunProviderComposition`). The suite should first
refuse a checkpoint over Control's 16 KiB limit (backlog 220): a cloud's operation ids are longer than Zerops'.
`entrypoint-isolation.test.ts` gets each new root. The CLI needs nothing: it maps `--provider=<id>` to
`@fabrika/provider-<id>/installation` and `/cli` (`packages/cli/src/index.ts`).

### N9. A neutral installation model (L, all three)

`@fabrika/installation-init` already holds fabrika's half: secrets, the four services' environment (with storage and
database coordinates "in the provider's own spelling"), the proxy manifest, MCP and OAuth, the sidecar, the pin. The
topology, the console schema and the upgrade path are still Zerops' (`packages/platform-artifacts`,
`provider-zerops/src/installation/`). A cloud whose infrastructure is a template needs the installation as data first:
the four services with image, port, health path, environment (literal or secret reference) and order; the databases and
buckets; the public hosts. Each provider renders that model into CloudFormation, Bicep or Terraform, and `platform deploy`
and `upgrade` apply it (ADR-0027).

### N10. The console's registration form (S, all three)

`FormProvider` is the closed union `'cloudflare' | 'zerops'` (`packages/dashboard/src/lib/provider-registration.ts`). A
provider whose artifact is the contract alone needs a form without a manifest file.

### N11. A backup before destructive migrations, and the backup view (S, per cloud)

Control hands `backupBeforeMigrations` to a provider without `dataOperations`
(`packages/provider-contract/src/control.ts`), and that provider backs up itself, as Zerops does. Each cloud has one call
for it (an RDS snapshot, a Flexible Server on-demand backup, a Cloud SQL backup run), and the read side of backlog 212 is
one read of the managed database.

### N12. The application roles on a managed PostgreSQL (live check, per cloud)

`provisionPostgresRoles` (`packages/platform-node/src/application-postgres-roles.ts`) needs `CREATEROLE`, not a
superuser: it creates the `app_<id>` and `run_<id>` roles with SCRAM verifiers derived from the provisioning password.
The admin roles of RDS, Azure and Cloud SQL all hold `CREATEROLE` and are not superusers; on PostgreSQL 16 and later such
a role administers the roles it created, which is all the provisioning credential does. Not verified on any of them; it
is the first live check of each provider.

## Effort

| Prerequisite                                |   Person-days | Needed by            |
| ------------------------------------------- | ------------: | -------------------- |
| N1 source without a descriptor              |           1–2 | all                  |
| N2 upload in parts                          |           3–4 | all                  |
| N3 container image from the recipe          |           3–5 | all                  |
| N4 PostgreSQL TLS test                      |           0.5 | all                  |
| N5 storage connection and credential source |           3–4 | all                  |
| N7 cron wakes in the Bun serving process    |           3–5 | all                  |
| N8 skeleton and conformance (backlog 220)   |           1–2 | all                  |
| N9 installation model                       |          6–10 | all                  |
| N10 console form                            |           1–2 | all                  |
| **Shared, once**                            |     **22–35** |                      |
| N6 native object store                      |      4–6 each | Azure (Google later) |
| N11, N12                                    | 1–2 per cloud | each                 |

The shared part is about a third of the first cloud's cost and none of the second's. With it done, the per-cloud work
is the package checklists on each page.

## One Kubernetes provider instead

The Google Cloud provider is a Kubernetes provider (Autopilot beats Cloud Run on every point that matters to Fabrika).
That raises the strategic alternative: one Kubernetes provider for all three clouds, on EKS, AKS and GKE, with only the
database, storage, registry, build and installation template differing per cloud.

|                                 | Native per cloud (ECS, Container Apps, GKE)      | One Kubernetes provider (EKS, AKS, GKE)                                                            |
| ------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Deploy code                     | Three deploy paths                               | One deploy path, three thin cloud layers                                                           |
| Monthly floor                   | No control plane fee on AWS and Azure            | EKS $0.10/h (about $73); AKS Free tier $0 without an SLA, Standard about $73; GKE one cluster free |
| Operation                       | The cloud upgrades its own runtime               | The operator lives with cluster upgrades on every cloud                                            |
| Fit with what operators ask for | "AWS" or "Azure" as their IT department knows it | Also covers an operator's own cluster (OpenShift, on-premises)                                     |
| Effort for all three            | ≈ 3 × 40 after the shared work                   | ≈ 40 + 2 × 20 after the shared work                                                                |

**Recommendation:** build the shared prerequisites now, because both paths need all of them. Choose the compute path when
the first committed installation names its cloud: if it is Google Cloud, or an operator mandates Kubernetes, build the
Kubernetes library first and the second cloud on it; if it is AWS or Azure without that mandate, build ECS or Container
Apps, which cost less to run and nothing to upgrade. Do not build any cloud package before an installation commits to
it: a provider without a live installation is untested by definition.

## Running cost of one small installation

The workload, the same on every cloud: IAM, Control, Operations, the platform proxy and one namespace proxy at 0.25 vCPU
and 0.5 GB, one application at 0.5 vCPU and 1 GB, all always on; PostgreSQL for the platform, Operations and the
application, each under 10 GB; 50 GB of files, 5,000 emails through an external adapter, 5 GB of logs and 20 GB of
outbound traffic a month. List prices, pay-as-you-go, read on 2026-11-24, USD.

| Setup                                                                          | USD/month | Source                                        |
| ------------------------------------------------------------------------------ | --------: | --------------------------------------------- |
| Zerops, single-node (2026-11-11 figure)                                        |        27 | Zerops pricing pages                          |
| Zerops, HA (2026-11-11 figure)                                                 |    85–146 | Zerops pricing pages                          |
| AWS: Fargate ARM, public task addresses, one ALB, RDS `db.t4g.small` Single-AZ |     ≈ 151 | AWS Price List API, eu-central-1              |
| AWS: one EC2 host running every container, RDS beside it (2026-11-11 figure)   |      ≈ 71 | AWS Price List API, eu-central-1              |
| Azure: Container Apps Consumption, Flexible Server `B1ms` (`B2s`: about +$44)  |    67–160 | Azure Retail Prices API, Germany West Central |
| Google Cloud: GKE Autopilot, one forwarding rule, Cloud SQL `db-custom-1-3840` |     ≈ 147 | Google pricing pages, US prices only          |
| Google Cloud on Cloud Run instead of Autopilot (compute only)                  |     ≈ 300 | Google pricing pages, US prices only          |

What it says: every one of the three costs several times the Zerops single-node shape, and each buys what Zerops does
not have, point-in-time recovery first. Azure's range is the idle rate of Container Apps, which only a live measurement
settles. Google Cloud's figure is a floor until the Frankfurt prices are read. The cost of each line is on the cloud's own
page.

## The order of the building work

The shared prerequisites go first, in small pull requests with tests, in this order: N4 (a test that pins what already
works), N1, N2, N3, N5, N8, N7, N10, N9. None of them changes what an existing installation runs: each adds a path a
future provider takes, and the Zerops and Cloudflare paths keep theirs.
