# An AWS provider

**Status of the idea.** Researched on 2026-11-11 from the code and public documentation; nothing deployed, no AWS
account touched. Not decided. Recommendation: build it with the first installation that needs AWS, not before;
meanwhile close the Zerops backup gap, which is the cheaper half of the motivation.

## Why the question comes up

- Public-sector and healthcare operators often ask for AWS or Azure in an EU region. A procurement or IT department
  that has never heard of Zerops may refuse it.
- Zerops keeps hourly PostgreSQL backups for about two days, restore is a manual download and `pg_restore`, and object
  storage is not backed up at all ([backlog 212](../backlog/212-the-console-shows-no-database-backups.md),
  [zerops-platform.md](../reference/zerops-platform.md)). A typical service-level target of at most one hour of lost data
  and a restore within a few hours is hard to meet on that. RDS keeps point-in-time recovery for up to 35 days.

## The short answer

The provider contract was built for this: ADR-0011 says adding a cloud is one provider package and one composition
root, with no change to shared Control code, the contract or the database schema. The runtime half is already
portable: IAM, Control and Operations run on Bun over Postgres and S3 through `@fabrika/platform-node`, and an
application on the paved road runs the same Bun entrypoint it runs on Zerops. What an AWS provider has to write is the
part Zerops gives for free: a build pipeline, a private network, a balancer with TLS, and the installation's
infrastructure. That is a real amount of work (estimate below: about 45–60 person-days for a first usable provider,
75–110 for parity with Zerops), and a small installation costs five to six times more per month on AWS than on
Zerops (about $151–159 against $27; with HA about $365 against $85–146).

## How AWS maps onto the provider contract

| Fabrika concept                           | Zerops today                                                 | AWS proposal                                                                             |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Installation (one cloud, ADR-0011)        | One Zerops project for the platform                          | One VPC in one region (eu-central-1), two availability zones                             |
| Long-running service                      | Zerops runtime service, `alpine/bun@1.3`                     | ECS service on Fargate (ARM), one task definition per service                            |
| Build (ADR-0003: no runner)               | Zerops build container, triggered over REST                  | CodeBuild project, triggered over the API; image pushed to ECR by digest                 |
| Source transport (ADR-0029)               | Control streams the GitHub tarball to the app version upload | The same stream, to a presigned S3 PUT that CodeBuild reads                              |
| Deploy and activation                     | `build-and-deploy`, readiness check gates activation         | Register a task definition, update the ECS service, health check gates, circuit breaker  |
| Migrations                                | `run.initCommands` on every container start                  | A non-essential init container in the same task, `dependsOn: SUCCESS`                    |
| Run checkpoint and recovery (ADR-0044)    | `{ appVersionId, triggered }`                                | `{ buildId, taskDefinitionArn, deploymentId }`, polled after a Control restart           |
| Secrets (ADR-0004)                        | Sensitive service variables                                  | SSM Parameter Store `SecureString` (KMS), injected by the task definition's `secrets`    |
| Managed environment                       | Service variables plus literals in the descriptor            | Task definition `environment` and `secrets`, written per run                             |
| Deployment namespace (ADR-0014)           | One Zerops project with its own proxy                        | One CloudFormation stack: security groups, a Cloud Map namespace, its proxy service      |
| Private network trust (ADR-0022 rule 5)   | Everything in a project reaches every port                   | Security groups: only the namespace proxy reaches an application's port                  |
| Public entry and TLS                      | Project L7 balancer, Zerops subdomain or custom domain       | One Application Load Balancer per installation, ACM certificates, host rules per proxy   |
| PostgreSQL                                | Managed `postgresql:single@18` / `ha@18` service             | RDS for PostgreSQL, Single-AZ or Multi-AZ, automated backups with point-in-time recovery |
| Object storage                            | Zerops object storage (MinIO), static keys                   | S3, Block Public Access, versioning, task-role credentials                               |
| Outbound email (ADR-0019)                 | An adapter (Postmark, Resend, …) or Control's relay          | The same adapters work unchanged; an SES adapter if mail must stay in AWS                |
| Cron (`run.crontab`)                      | Zerops crontab in the container                              | A scheduler inside the long-running container (first), EventBridge Scheduler later       |
| Service logs                              | Zerops project log service                                   | CloudWatch Logs (`awslogs` driver), retention set per log group                          |
| Installation tooling (ADR-0025, ADR-0027) | `platform install/deploy/upgrade --provider=zerops`          | The same commands rendering and applying one CloudFormation template                     |
| Sidecar pipeline credential               | A Zerops integration token in a GitHub Environment           | GitHub OIDC federation to an IAM role: no long-lived key anywhere                        |

### Compute: ECS on Fargate

- **ECS on Fargate (recommended).** No hosts to patch, per-second billing, one security group per task (`awsvpc`), a
  task IAM role per service, service discovery through Cloud Map, a health-checked rolling deploy with automatic
  rollback (the deployment circuit breaker), and init containers through `dependsOn`. Its shape is close to a Zerops
  runtime service, so the provider stays an HTTP client like `provider-zerops` and needs no runner.
- **App Runner.** The closest thing to Zerops on paper (build, TLS and scaling in one service), but AWS stopped taking
  new customers for it (see [the costs section](#running-cost-of-one-small-installation)), it has no init containers
  and limited private networking. Rejected. AWS's suggested successor, ECS Express Mode, was not evaluated; it is ECS
  underneath, so it would at most simplify the balancer and TLS part of this design.
- **EKS.** A Kubernetes control plane costs about $73 a month per cluster ($0.10/h list price, not re-checked) before
  any workload, and running Kubernetes
  is a job of its own. Nothing in Fabrika needs it for five to ten containers. Rejected; it would only make sense if a
  operator mandates Kubernetes, and then it is a different provider.
- **EC2 (one instance running every container).** The cheapest floor, but one machine to patch, no zone redundancy,
  and Fabrika would own the container runtime. Worth keeping as an ECS capacity provider for a "light" tier later, not
  as the design.

### Build and deploy pipeline

ADR-0003's reasoning carries over: AWS has its own build container (CodeBuild), so Control drives AWS over HTTP and no
Fabrika runner exists on AWS either.

1. Control resolves the commit and streams the GitHub tarball, through the existing tar rewrite and validation, to a
   presigned S3 PUT (today the transport accepts only the measured Zerops upload host;
   `packages/control/src/github/source/transport.ts`).
2. Control starts a CodeBuild build of a buildspec and a `Dockerfile` it generates from the neutral `contractRecipe`
   (`@fabrika/app/build`), the same recipe `packages/provider-zerops/src/execution.ts` renders into a `zerops.yaml` today.
   The build runs the checker, uploads source maps to Operations (the `artifactUpload` of the contract) and pushes
   the image to ECR. The image digest, not a tag, goes into the task definition.
3. Control registers a task definition: the application container, an init container that runs `fabrika db migrate`,
   `fabrika db codegen --verify` and `fabrika db test-isolation`, the managed environment, and secrets by reference.
4. Control updates the ECS service and polls the deployment until it is `COMPLETED` or rolled back. The container
   health check requests the contract's health endpoint, which is what Zerops' readiness check does.

A run's checkpoint is the build id, then the task definition ARN, then the deployment id; a Control restart polls the
step it reached, as ADR-0044 does for an app version. An init container also improves on Zerops: ECS gives each
container its own environment, so the provisioning credential reaches the migration container only and never the
application's process, which on Zerops needs the launcher workaround of ADR-0017.

### PostgreSQL: RDS

- **RDS for PostgreSQL, not Aurora.** Aurora Serverless v2 has a higher floor than a small RDS instance for an
  always-on database, and Aurora's strengths (fast failover, storage that grows by itself, read replicas) are not what a
  small installation needs. Plain RDS has everything the motivation asks for.
- **Backups.** Automated backups with point-in-time recovery, retention 1–35 days, restorable to any second up to
  about five minutes ago. That meets an RPO of one hour with room to spare. A restore creates a **new** instance, so
  Fabrika needs a repoint step (new endpoint into the secrets, redeploy). AWS Backup adds longer retention and a copy to
  a second region when an operator asks for it.
- **The backup view of backlog 212** becomes a thin read: `DescribeDBInstances` returns the retention and the latest
  restorable time directly.
- **Roles.** The RDS master user is `rds_superuser`, not a Postgres superuser, but it holds `CREATEROLE`.
  `provisionPostgresRoles` already accepts a `CREATEROLE` caller (`packages/platform-node/src/application-postgres-roles.ts`),
  so ADR-0017's role family should work unchanged. Verify on a live instance.
- **TLS.** RDS for PostgreSQL 15 and later forces TLS by default; the Zerops URLs say `sslmode=disable`. The AWS URL
  needs `sslmode=verify-full` and the RDS CA bundle in the image.
- **One instance, many databases.** The smallest RDS instance costs several times a Zerops `oltp-hobby` service, so
  the cheap AWS shape is one instance for the whole installation with a database per application, which is exactly the
  design in [A compact installation](compact-installation.md) (a `prov_<id>` `CREATEROLE` role and a database per
  application, `REVOKE CONNECT ON DATABASE` for the platform's). On AWS the network gates of that idea fall away: RDS is
  reachable only from the security groups that are allowed to reach it. A `full` namespace gets its own instance.
- **Connections.** `max_connections` follows the instance class (about 80 on a 1 GB instance) and does not autoscale
  as on Zerops; the connection budget in `packages/platform-node/src/connection-capacity.ts` has to be sized against it.
- **Version.** Zerops runs PostgreSQL 18; confirm RDS offers the same major version in eu-central-1 before relying on it.

### Files: S3

One private bucket per installation for platform data (run logs, Operations raw events and source maps) and one per
application environment, with Block Public Access, default encryption, versioning and a lifecycle rule that expires
old versions after 30 days. Versioning gives files the backup Zerops does not have. `S3BlobStore` uses `Bun.S3Client`
with static keys and already takes a session token; a task role hands out credentials that rotate, so the store needs
a credential refresh from the container credentials endpoint (or the provider issues per-bucket access keys, which
then need rotating). The application's `FABRIKA_APP_STORAGE_*` variables keep their names.

### Email

Email is already portable (ADR-0019): an installation on AWS can keep Postmark, Resend or any other adapter, and
Control's relay works as on Zerops. An SES adapter (SES API v2 over HTTPS with SigV4) is small, but SES needs a
verified domain with DKIM records and a production-access request (new accounts start in the sandbox), and bounces and
complaints arrive through SNS, which is its own wiring (compare backlog 217). Build it only when an operator wants mail to
stay inside AWS.

### Secrets

ADR-0004 holds: secrets live in the platform. Control writes an application's secrets as SSM `SecureString`
parameters under `/fabrika/<installation>/<namespace>/<app>/<env>/` and the task definition references them, so ECS
injects them at start; a changed secret takes effect on the next deploy, as on Zerops. The free standard tier is
enough; Secrets Manager adds rotation that Fabrika does not use. Two improvements are available: the Control vault's
key-encryption key can live in KMS and never leave it, and Control can read its own parameters back, so deploys can
compare values instead of writing blind as on Zerops (`REDACTED` outside sudo mode).

### Networking and TLS

- One VPC per installation in two availability zones, one internet-facing Application Load Balancer, ACM certificates
  (free, renewed by AWS) validated by DNS records the operator adds, host rules sending each host to the platform proxy
  or a namespace proxy.
- The ALB appends `X-Forwarded-For` and its source is the VPC, so Caddy's `trusted_proxies` can be the VPC range and
  rate limits get a real client address, which on Zerops is still unsettled (backlog 05).
- Tasks need outbound access (GitHub, ECR, the email provider). A NAT gateway is the textbook answer and a large share
  of a small bill; tasks in public subnets with a public IPv4 address and an ingress-free security group are the cheap
  answer. Interface VPC endpoints cost about as much as a NAT gateway once there are four or five of them.
- Rule 5 of ADR-0022 (a namespace is one private network, the proxy secret authenticates the hop) maps onto security
  groups and becomes stronger: an application's port accepts connections only from its namespace proxy's group.

### Deployment namespaces

A namespace is one CloudFormation stack that Control creates and updates (ADR-0034): its security groups, its Cloud
Map namespace, its proxy service, its ALB rules and certificates, and, for `full`, its own RDS instance. The stack's
status is the provisioning checkpoint, `UpdateStack` is reconcile, drift detection answers `claimedResources`.
Presets on AWS:

| Preset  | Proxy           | PostgreSQL                                        |
| ------- | --------------- | ------------------------------------------------- |
| `cheap` | Namespace-owned | A database per application in the shared instance |
| `full`  | Namespace-owned | An RDS instance owned by the application          |

`mid` has no AWS reason to exist: an application-owned database in a shared instance is what `cheap` already is.

### Cron and jobs

Zerops runs `run.crontab` inside the container, one container at a time. The simplest AWS equivalent is the same: a
small scheduler inside each long-running container, with the job leases Fabrika already has keeping two tasks from
running one job twice. EventBridge Scheduler starting an ECS task per run is cleaner but adds a cold start of tens of
seconds and an IAM role per schedule; it is the second step, not the first.

### Observability

Service logs go to CloudWatch Logs with a set retention. Control's run log is pulled, as on Zerops: CodeBuild's log
and the ECS service's deployment events. The Operations plane (errors, releases, source maps, alerts) is Fabrika's own
and does not change. Container Insights and alarms are optional extras with their own price.

### Installation (operator side)

`fabrika platform install --provider=aws` renders one CloudFormation template for the installation (VPC, subnets,
security groups, ALB, RDS, buckets, ECR repositories, the CodeBuild project, the ECS cluster and services, log groups,
KMS key, IAM roles) and applies it through a change set the operator approves. `platform deploy` builds the platform
images through CodeBuild and updates the stack's image digests in the order IAM and Operations, proxy, Control
(ADR-0027: as wide as the provider needs). The sidecar workflow reaches AWS through GitHub OIDC federation, so no AWS
key is stored anywhere. Control's own IAM role is the security-sensitive part: it may create and change only resources
tagged as its namespaces, under a permissions boundary that keeps it off the platform's own resources, which is what
"reconcile refuses the installation's own project" does on Zerops.

## What in Fabrika assumes Zerops or Cloudflare today

Most of it is inside the provider packages, where it belongs. Outside them:

| Where                                                                | Assumption                                                                    | Change for AWS                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------- |
| `packages/provider-zerops/src/execution.ts`                          | The contract application's build and run chain is rendered as a `zerops.yaml` | An AWS renderer of the same `contractRecipe`         |
| `packages/check/src/rules/crontab.ts`, `layout.ts`                   | An application's cron lives in `zerops.yaml`                                  | Read schedules from the contract, not the descriptor |
| `packages/auth-core/src/framework-variables.ts`                      | Variable values may hold Zerops `${host_NAME}` references                     | AWS values are literal or a secret reference         |
| Zerops database URLs                                                 | `sslmode=disable`, superuser over Zerops references                           | `verify-full`, the RDS CA bundle, `rds_superuser`    |
| `packages/app/src/bun.ts`, `packages/platform-node/src/blob-s3.ts`   | Object storage is path-style MinIO with static keys                           | Virtual-hosted S3, rotating task-role credentials    |
| `packages/proxy/src/caddy.ts`, `generate-config.ts`                  | TLS ends at the Zerops balancer; the config is generated in the Zerops build  | Same Caddy behind the ALB; trust the VPC range       |
| `packages/auth-core/src/wire.ts`, `packages/iam/src/proxy-proof.ts`  | "On Zerops a namespace is one private network"                                | The same scheme, enforced by security groups         |
| `packages/control/src/github/source/transport.ts`                    | Uploads only to the measured `prg1` destination                               | Accept a presigned S3 PUT for the AWS composition    |
| `packages/dashboard/src/lib/provider-registration.ts`                | `FormProvider = 'cloudflare' \| 'zerops'`                                     | Add `aws`                                            |
| `packages/cli`                                                       | The official provider ids are `cloudflare` and `zerops`                       | Add `aws` (any package specifier already works)      |
| `packages/platform-artifacts`, `provider-zerops/src/installation`    | Installation codegen and the six-step guide are Zerops-only                   | An AWS template, guide and upgrade path              |
| `packages/local-stack` (Zerops emulator, 1,350 lines)                | The end-to-end stack emulates Zerops                                          | An AWS double, or provider tests against fakes only  |
| `packages/platform-node/src/sql-postgres.ts`                         | No named prepared statements because of Zerops' pgBouncer                     | Nothing; harmless on RDS                             |
| [MCP dev environment](mcp-dev-containers.md), file scanning (ClamAV) | Measured on Zerops; system packages through `run.prepareCommands`             | Later; packages go into the generated `Dockerfile`   |

None of these needs a structural change. The provider contract, Control's lifecycle, IAM, Operations, the proxy's
enforcement decision and the application framework stay as they are.

## Effort

Estimated in person-days of one engineer working the way this repository is built (with agents). For calibration: the
Zerops provider is about 15,000 lines of source and 20,000 of tests, 360 commits since 2026-07-29, and its platform
facts (`zerops-platform.md`, 1,560 lines) were each paid for with a live run. AWS is better documented than Zerops, so
fewer facts need discovering, but it hands over less: the network, the balancer, TLS and the build image are Fabrika's
to declare. Treat each number as ±30 %.

| Part                                                                                                    |     Parity | First usable |
| ------------------------------------------------------------------------------------------------------- | ---------: | -----------: |
| Provider skeleton: codecs, `defineApp`, registration, conformance harness                               |        4–6 |            4 |
| AWS client layer (SDK v3 clients for ECS, CodeBuild, ECR, S3, SSM, CloudFormation, RDS) and fakes       |        4–6 |            4 |
| Build: source to S3, generated buildspec and `Dockerfile`, ECR, source maps, build log relay            |        6–9 |            6 |
| Deploy: task definitions, init-container migrations, rollout, rollback, checkpoint, reconcile, cancel   |       8–12 |            8 |
| Secrets and the managed environment                                                                     |        2–3 |            2 |
| PostgreSQL on RDS: TLS, role provisioning, connection budget, restore and repoint runbook               |        4–6 |            4 |
| Files on S3: buckets, task-role credentials in `S3BlobStore` and the application                        |        2–4 |            2 |
| Email: SES adapter and live verification (first version keeps an existing adapter)                      |        2–3 |            0 |
| Namespaces: presets, security groups, Cloud Map, namespace proxy, ALB rules and certificates, claims    |      10–14 |  5 (`cheap`) |
| Cron and jobs                                                                                           |        2–4 |            2 |
| Installation: CloudFormation template, install/deploy/upgrade, least-privilege IAM, OIDC sidecar, guide |      12–18 |            8 |
| Observability and the backup read of backlog 212                                                        |        3–4 |            2 |
| Console forms and CLI wiring                                                                            |        2–3 |            0 |
| Local AWS double for the end-to-end stack and CI                                                        |        5–8 |            0 |
| Live bring-up on a real account, `aws-platform.md` facts, ADRs                                          |       8–12 |            6 |
| **Total**                                                                                               | **75–110** |     **≈ 53** |

"First usable" is one installation running one application in a `cheap` namespace, with the ALB hosts, DNS and
certificates set by hand, mail through an existing adapter, no console form and no local double: about **45–60
person-days**, two to three calendar months for one person.

## Running cost of one small installation

Prices read on **2026-11-11**, pay-as-you-go list prices without Savings Plans, reservations or discounts. AWS from
the AWS Price List API (eu-central-1 offer files published 2026-09-11 to 2026-11-10), Azure from the Azure Retail
Prices API (Germany West Central), Zerops from [docs.zerops.io/billing/pricing](https://docs.zerops.io/billing/pricing)
and [zerops.io/pricing](https://zerops.io/pricing). EUR at the ECB reference rate of 2026-11-10 (1 EUR = 1.1214 USD).
A month is 730 hours; Zerops bills per 30 days, so its real monthly figure is about 1.4 % higher.

**The workload (a small installation: one application, a small database, low traffic):** IAM, Control, Operations, the platform proxy, one namespace proxy and one
application, always on. Five containers at 0.25 vCPU and 0.5 GB, the application at 0.5 vCPU and 1 GB (1.75 vCPU and
3.5 GB in total). PostgreSQL for the platform, Operations and the application, each under 10 GB. 50 GB of files,
5,000 emails, 5 GB of logs and 20 GB of outbound traffic a month.

| Setup                                                                                      |     USD/month |     EUR/month |
| ------------------------------------------------------------------------------------------ | ------------: | ------------: |
| **Zerops**, single-node (Lightweight core, `oltp-hobby` databases)                         |            27 |            24 |
| **Zerops**, HA (two Serious projects, three-node PostgreSQL)                               |        85–146 |        76–130 |
| **AWS (a)** Fargate ARM, public task IPs, one ALB, RDS `db.t4g.small` Single-AZ            |       151–159 |       135–141 |
| **AWS (a′)** one EC2 `t4g.medium` running every container, Caddy terminating TLS, same RDS |            71 |            64 |
| **AWS (b)** Fargate doubled, two NAT gateways, RDS `db.t4g.medium` Multi-AZ                |           365 |           325 |
| **Azure (a)** Container Apps (consumption), PostgreSQL Flexible `B1ms`                     | 91 (≈ 60–160) | 81 (≈ 55–145) |
| **Azure (b)** Container Apps doubled, `D2ads_v5` with zone-redundant HA                    |           456 |           407 |

What makes up the AWS figure (a), per month:

| Item                         | Configuration                                        | Unit price                       |   USD |
| ---------------------------- | ---------------------------------------------------- | -------------------------------- | ----: |
| Fargate ARM                  | 1.75 vCPU, 3.5 GB, always on                         | $0.03725/vCPU-h, $0.00409/GB-h   | 58.04 |
| Application Load Balancer    | one, about 1 LCU                                     | $0.027/h, $0.008/LCU-h           | 32.85 |
| RDS for PostgreSQL           | `db.t4g.small` Single-AZ, 20 GB gp3, three databases | $0.037/h, $0.137/GB-month        | 29.75 |
| Public IPv4                  | six task addresses instead of a NAT gateway          | $0.005/IP-h                      | 21.90 |
| Secrets Manager              | 20 secrets (SSM Parameter Store standard: $0)        | $0.40/secret-month               |   0–8 |
| CloudWatch Logs              | 5 GB ingested and stored                             | $0.63/GB, $0.0324/GB-month       |  3.31 |
| S3                           | 50 GB, ~100k PUT, ~1M GET                            | $0.0245/GB                       |  2.20 |
| KMS, ECR, Route 53, SES      | one key, 5 GB images, one zone, 5,000 emails         | $1, $0.10/GB, $0.50, $0.10/1,000 |  2.50 |
| Backups (PITR up to 35 days) | free up to the provisioned storage                   | $0.103/GB-month beyond           |     0 |
| Outbound traffic             | 20 GB, inside the free 100 GB                        | $0.09/GB beyond                  |     0 |

What it says:

- **Zerops is five to six times cheaper for the small single-node shape** (about $27 against $151–159). AWS has fixed
  costs before any workload runs: the load balancer ($33) and either public IPv4 addresses ($22) or NAT gateways ($35
  each plus traffic). The database is the cheapest it can sensibly be; `db.t4g.micro` ($13.87) has 1 GB of memory and
  about 80 connections for three services and an application, too tight.
- **For HA the gap narrows** to roughly 2.5–4× (Zerops $85–146, AWS $365), and AWS buys something Zerops does not
  have: point-in-time recovery for up to 35 days, a Multi-AZ standby with automatic failover, and object storage
  versioning.
- **The single-EC2 shape ($71)** is the honest cheap AWS answer for an operator who wants "AWS" and not HA: one machine,
  Caddy terminating TLS, RDS with point-in-time recovery beside it. It is a different provider shape (Fabrika owns the
  container runtime on the host), so it is not free to support next to ECS.
- **Azure (a) is cheaper than AWS (a)** ($91), because Container Apps has built-in ingress and TLS and no NAT or
  balancer to pay; the range depends on how much of the time the containers are busy. **Azure HA is the most expensive**
  ($456): Burstable PostgreSQL servers cannot be zone-redundant, so HA forces a general-purpose server, and the standby
  is billed like the primary.
- **Backups, side by side.** Zerops keeps full dumps (daily by default, hourly where `platform deploy` sets it) and at
  most 50 per service, which at an hourly schedule is the "about two days" of backlog 212; there is no point-in-time
  recovery and restore is manual ([docs.zerops.io/features/backup](https://docs.zerops.io/features/backup)). RDS and
  Azure Flexible Server both restore to any second within 7–35 days, into a new server.
- **Email** costs about $0.50 a month at this volume on any of them (SES $0.10 per 1,000; Zerops has no mail service,
  so an external provider, which Fabrika uses anyway).

Least certain: the ALB's capacity units, the Container Apps busy/idle split (±$70 on Azure), Zerops backup sizes, and
the AWS free tiers for egress and CloudWatch, which were not re-verified. App Runner is closed to new customers
([AWS notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html); the English page
gives no date, a localized page names 2026-04-30); AWS points new users at ECS Express Mode instead, which was not
evaluated here.

## Risks

- **Cost of the floor.** An AWS installation has fixed monthly costs (balancer, database instance, network egress
  path) that Zerops does not, so it never gets as cheap, and every extra database instance is a visible line.
- **Two providers to keep current.** Every change to the delivery path, the managed environment or the proxy has to be
  made and verified twice (three times with Cloudflare). Without a live installation on AWS the provider rots; a
  provider without a live installation is untested by definition (compare backlog 213 for Cloudflare).
- **IAM is a security boundary Fabrika has not owned before.** Control's role must be able to create namespaces and
  must not be able to touch the platform. A mistake there is worse than on Zerops, where the token's reach is one
  project.
- **No faithful local emulator.** LocalStack covers S3, SSM and SES, but ECS, RDS and CodeBuild behave differently from
  the real services or sit behind its paid tier. Tests run against fakes, and the facts come from a live account,
  which costs money while it runs.
- **Slower feedback.** A CloudFormation update, a CodeBuild image build and an ECS rollout each take minutes. A Zerops
  deploy is not fast either, but the MCP authoring loop (a dev environment that takes a commit in seconds) would need its
  own design on AWS.
- **Requirements beyond the region.** An operator asking for AWS may also ask for its own AWS account, its own
  landing zone, private connectivity or the AWS European Sovereign Cloud (generally available since 2026-01-15, region
  in Brandenburg; services and prices not checked here). "Install into the operator's own account" is a supported shape
  (ADR-0025: the operator installs the platform), but each such requirement is extra work.
- **Price changes.** AWS prices move rarely but the free-tier and IPv4 rules have changed in recent years; the
  numbers here are a snapshot.

## If the installation must run on Azure

The same provider shape works, and some parts fit better than on AWS:

- **Compute: Azure Container Apps.** Closer to Zerops than ECS: one Container Apps environment is one private network
  with built-in ingress, TLS and managed certificates for custom domains, internal-only apps, revisions with traffic
  switching, and Container Apps Jobs for cron and one-off runs (migrations). A namespace maps naturally to an
  environment, as it maps to a project on Zerops. No separate load balancer to pay for.
- **Build: ACR Tasks** (`az acr build`) in place of CodeBuild, images in Azure Container Registry.
- **PostgreSQL: Azure Database for PostgreSQL Flexible Server**, point-in-time recovery 7–35 days, zone-redundant HA
  as an option. The admin role is `azure_pg_admin`, not a superuser, with `CREATEROLE`; same verification as RDS.
- **Files: the real difference.** Azure Blob Storage does not speak the S3 API. Fabrika's `BlobStore` and the
  application's `FABRIKA_APP_STORAGE_*` assume S3, so Azure needs a second blob implementation in `platform-node` and
  in the application runtime, with SAS tokens where S3 uses presigned URLs. Add roughly 5–8 person-days.
- **Email: Azure Communication Services Email**, a new adapter; or keep an existing one.
- **Secrets: Key Vault**, referenced from Container Apps secrets through a managed identity.
- **Infrastructure: Bicep/ARM deployments** in place of CloudFormation, with the same "one document per namespace"
  model. Sidecar authentication through GitHub OIDC works the same way.

Overall an Azure provider would cost about the same effort as AWS plus the blob storage work, and only one of the two
should be built first: whichever the first installation needs.

## Recommendation

**Build it with the first installation that needs it, not now.** In order:

1. **Now, on Zerops (a few days):** close the backup gap without AWS. An hourly logical dump of each database to object
   storage outside Zerops with 30 days of retention, a rehearsed restore, and the backup view of backlog 212. That
   answers a recovery point of one hour and a restore within a few hours.
2. **When AWS is asked for:** describe it as possible with a one-time setup effort and the monthly price from the
   table above, rather than as something Fabrika runs today.
3. **When an installation on AWS is committed:** build the first usable provider (about 45–60 person-days) with that
   installation as the live acceptance, then grow it to parity only as more installations arrive. Do not build it
   on speculation: an AWS provider without a live installation is a cost with no feedback.
4. **Until then:** when touching the code in the table above, make the Zerops assumptions neutral where it is free
   (cron read from the contract, the source transport's upload destination, the URL's TLS mode).

A reason to start earlier would be several operators asking for AWS at once, or Zerops failing an operator's audit
outright. Neither is true today.

## Open questions before any code

- Does RDS's `rds_superuser` run `provisionPostgresRoles` and `fabrika db test-isolation` unchanged?
- Does Bun.SQL connect with `sslmode=verify-full` to RDS with the RDS CA bundle?
- Does `Bun.S3Client` accept rotating credentials, or does the store need to be recreated on expiry?
- Is PostgreSQL 18 available on RDS in eu-central-1, or do installations on AWS run 17?
- Will the first AWS installation live in the operator's own AWS account? That decides whether `platform install`
  creates the VPC or adopts one.
