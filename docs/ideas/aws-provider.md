# An AWS provider

**Status of the idea.** First researched on 2026-11-11; re-checked on 2026-11-24 against the code at `11e8da5bf` and
the current AWS documentation and price list. Nothing deployed, no AWS account touched. Not decided. The prerequisites
every cloud shares, and how AWS compares with Azure and Google Cloud, are in [Fabrika on the big three clouds](cloud-providers.md); this page holds what is true of AWS.

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
infrastructure. Before the AWS package itself, about a dozen provider-neutral prerequisites have to land (source upload
in parts, a container image from the build recipe, TLS to the database, storage credentials that rotate, cron without a
crontab, an installation model); they are listed once in [the comparison](cloud-providers.md#the-shared-prerequisites).

The service choices of 2026-11-11 hold, with three changes: ECS now has **pause hooks** that can run a migration once
per deployment, ECS recommends **Service Connect** over plain Cloud Map, and a new **regional NAT gateway** exists. ECS
Express Mode, which AWS now points App Runner customers to, was evaluated and does not fit (below).

Effort: about 22–35 person-days of shared prerequisites, then about 39 for a first usable AWS provider and 51–78 for
parity with Zerops. A small installation costs about $151 a month on AWS against about $27 on Zerops.

## What changed since 2026-11-11

In the code:

- The source transport's destination is injected by the composition (`isUploadDestination`,
  `packages/control/src/github/source/transport.ts`), so the earlier "accepts only `prg1`" is out of date. What does
  not travel is the request: one streamed `PUT` without a length, which S3 refuses.
- `contractRecipe` (`@fabrika/app/build`) now also runs the application's own test script and a schema check on a
  throwaway PostgreSQL in the build; the check installs PostgreSQL with `sudo apk add`, which a Docker build does not
  have.
- The proxy's trusted proxy ranges are configurable (`FABRIKA_PROXY_TRUSTED_PROXIES`, `packages/proxy/src/generate-config.ts`).
- The CLI maps any `--provider=<id>` to `@fabrika/provider-<id>/installation` and `/cli`; nothing there names AWS.
- Control hands a provider without `dataOperations` a `backupBeforeMigrations` list; Zerops backs up before a
  migration that deletes data, and AWS would take an RDS snapshot there.
- A cron job may now reach the public web (`egress: 'public'`, ADR-0075); on AWS that needs outbound internet from the
  task, which the network design below gives.

In AWS:

- **ECS Express Mode** exists (below). **ECS lifecycle hooks**: native blue/green, linear and canary deployments with
  Lambda hooks and **pause hooks** that wait for `ContinueServiceDeployment`
  ([pause hooks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/pause-lifecycle-hooks.html)).
- **Service Connect** is the recommended way to connect services
  ([interconnecting services](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/interconnecting-services.html)).
- **PostgreSQL 18** is on RDS since 2025-11-14, minor 18.6
  ([release calendar](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-release-calendar.html)).
- **Aurora Serverless v2 scales to 0 ACU** with auto-pause
  ([auto-pause](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)).
- **Regional NAT gateway**: one NAT for every zone, no public subnet
  ([regional NAT](https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateways-regional.html)).
- **CloudFormation**: 300,000 stacks per account by default, and stack refactoring moves resources between stacks
  ([quotas](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/cloudformation-limits.html)).
- The **AWS European Sovereign Cloud** (Germany) is live and gaining services this month; no official service list on
  docs.aws.amazon.com was found.

## How AWS maps onto the provider contract

| Fabrika concept                           | Zerops today                                                 | AWS                                                                                            | Rejected                                          |
| ----------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Installation (one cloud, ADR-0011)        | One Zerops project for the platform                          | One VPC in one region (eu-central-1), two availability zones, one AWS account or a given one   | A multi-account landing zone (later)              |
| Long-running service                      | Zerops runtime service, `alpine/bun@1.3`                     | ECS service on Fargate (ARM64), one task definition per service                                | Express Mode, App Runner, EKS, one EC2 host       |
| Build (ADR-0003: no runner)               | Zerops build container, triggered over REST                  | CodeBuild, `NO_SOURCE` with an inline buildspec; image to ECR, deployed by digest              | Building in Control; CodePipeline                 |
| Source transport (ADR-0029)               | Control streams the GitHub tarball to the app version upload | The same stream as an S3 multipart upload; the build fetches it through a presigned GET        | One presigned PUT (needs a length)                |
| Deploy and activation                     | `build-and-deploy`, readiness check gates activation         | Register a task definition, update the service, health check gates, circuit breaker rolls back |                                                   |
| Migrations                                | `run.initCommands` on every container start                  | One `RunTask` per init command before the service update; later perhaps a pause hook           | An init container in every task                   |
| Run checkpoint and recovery (ADR-0044)    | `{ appVersionId, triggered }`                                | `{ buildId, taskDefinitionArn, deploymentArn }`, each recorded before the call that needs it   |                                                   |
| Secrets (ADR-0004)                        | Sensitive service variables                                  | SSM Parameter Store standard `SecureString`, injected by the task definition's `secrets`       | Secrets Manager ($0.40 a secret, rotation unused) |
| Managed environment                       | Service variables plus literals in the descriptor            | Task definition `environment` and `secrets`, written per run                                   |                                                   |
| Deployment namespace (ADR-0014)           | One Zerops project with its own proxy                        | One CloudFormation stack: security groups, a Service Connect namespace, its proxy service      | Cloud Control API per resource                    |
| Private network trust (ADR-0022 rule 5)   | Everything in a project reaches every port                   | Security groups: only the namespace proxy's group reaches an application's port                | VPC Lattice ($0.0325 a service-hour)              |
| Public entry and TLS                      | Project L7 balancer, Zerops subdomain or custom domain       | One Application Load Balancer per installation, ACM certificates, host rules per proxy         | A balancer per namespace; Express's own ALB       |
| PostgreSQL                                | Managed `postgresql:single@18` / `ha@18` service             | RDS for PostgreSQL 18, `db.t4g.small` Single-AZ (Multi-AZ for HA), PITR up to 35 days          | Aurora (Serverless v2 or provisioned)             |
| Object storage                            | Zerops object storage (MinIO), static keys                   | S3, Block Public Access (default), SSE-S3 (default), versioning, task-role credentials         |                                                   |
| Outbound email (ADR-0019)                 | An adapter (Postmark, Resend, …) or Control's relay          | The same adapters unchanged; an SES adapter only when mail must stay in AWS                    |                                                   |
| Cron (`run.crontab`)                      | Zerops crontab in the container                              | The serving process keeps cron wakes (shared prerequisite N7)                                  | EventBridge Scheduler per job (fallback)          |
| Service logs                              | Zerops project log service                                   | CloudWatch Logs (`awslogs`), retention set per log group                                       |                                                   |
| Installation tooling (ADR-0025, ADR-0027) | `platform install/deploy/upgrade --provider=zerops`          | The same commands, rendering one CloudFormation template and applying it by change set         | CDK, Terraform (a toolchain in Control)           |
| Sidecar pipeline credential               | A Zerops integration token in a GitHub Environment           | GitHub OIDC federation to an IAM role: no long-lived key anywhere                              | An access key in a GitHub secret                  |

## The service choices

### Compute: plain ECS on Fargate

- **ECS on Fargate (chosen).** No hosts to patch, per-second billing, one security group per task (`awsvpc`), a task
  IAM role per service, Service Connect for service-to-service names, a health-checked rolling deploy with automatic
  rollback (the circuit breaker), and init containers through `dependsOn` (`START`, `COMPLETE`, `SUCCESS`, `HEALTHY`;
  `SUCCESS` needs a non-essential container,
  [task definition parameters](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html)).
  Fargate runs ARM64 ([ARM64 on ECS](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-arm64.html)).
  The provider stays an HTTP client like `provider-zerops` and needs no runner.
- **ECS Express Mode (rejected).** Given an image and two roles it creates a Fargate service with canary deploys and
  autoscaling, an ALB with an HTTPS listener and host rules, an ACM certificate, security groups and a log group, at no
  charge of its own; up to 25 services share one ALB per VPC
  ([how it works](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-work.html)). With
  private subnets it provisions an internal ALB and no public task address, so an Express service can be private, and
  it takes a custom task definition as it is, init containers included. It still does not fit Fabrika: the first Express
  service in a VPC fixes the balancer's scheme for the VPC, and every Express service is a host rule on that one shared
  balancer, whose security group admits HTTPS. Whatever reaches the balancer reaches every Express service in the VPC by
  its `Host` header, across namespaces, while ADR-0022 needs an application reachable only from its own namespace proxy,
  which plain ECS gives with a security group per proxy. The balancer configuration and the deployment strategy (canary)
  cannot be changed after creation, and custom domains are a manual listener change. It could front the platform proxy
  at most, and that saves one listener rule. Express services keep the full ECS feature set, so nothing here closes the
  door later.
- **App Runner (rejected).** Closed to new customers
  ([notice](https://docs.aws.amazon.com/apprunner/latest/dg/apprunner-availability-change.html)).
- **EKS (rejected for this provider).** $0.10 an hour per cluster before any workload, and a Kubernetes control plane to
  upgrade. If an operator mandates Kubernetes, the right answer is a Kubernetes provider shared by EKS, AKS and GKE
  ([the comparison](cloud-providers.md#one-kubernetes-provider-instead)), not an AWS-only one.
- **One EC2 host running every container.** The cheapest floor (about $71 a month with RDS beside it), but one machine
  to patch, no zone redundancy, and Fabrika would own the container runtime. Kept as a possible capacity provider for a
  "light" tier, not as the design.

### Build: CodeBuild and ECR

- **CodeBuild (chosen).** ARM build images (`amazonlinux-aarch64-standard`), the Docker daemon on by default outside a
  VPC, ARM small at $0.00385 a minute
  ([compute types](https://docs.aws.amazon.com/codebuild/latest/userguide/build-env-ref-compute-types.html)). Its S3
  source accepts only a ZIP file or a folder
  ([ProjectSource](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_ProjectSource.html)), while Control
  produces a gzip tar. So the build starts with `sourceTypeOverride: NO_SOURCE` and an inline buildspec
  ([StartBuild](https://docs.aws.amazon.com/codebuild/latest/APIReference/API_StartBuild.html)) whose first command
  fetches the tarball through a short-lived presigned GET and unpacks it. Repacking as a ZIP is the alternative; it
  costs a second archive writer and gains nothing.
- The buildspec writes the `Dockerfile` rendered from `contractRecipe` (shared prerequisite N3), builds for
  `linux/arm64`, pushes to ECR and prints the digest; the source-map bearer is a build secret, never a build argument.
- **ECR** keeps the images, a lifecycle policy expires old ones, and the task definition names the digest, never a tag.
  ECR's pull-through cache can mirror the Bun base image, so a build does not depend on Docker Hub's rate limit.

### Migrations: one task per deploy, before the update

The deploy runs each init command of `containerImage` (the migrations, then the schema check) once, as a one-off task
of the application environment's init definition (`RunTask` with a command override), in order, and updates the
service only after every one exited 0 (`src/ecs-task.ts`). The init definition alone holds the provisioning credential
(`FABRIKA_APP_DATABASE_URL`); the server's holds the runtime role's URL (`FABRIKA_APP_RUNTIME_DATABASE_URL`, a parameter
the deploy writes), so no application process ever holds the credential that creates roles, which on Zerops only the
launcher of ADR-0017 keeps from it.

An init container in every task was the first idea, and was rejected: the schema check fails against a schema a newer
revision migrated, so a rollback, a replacement or a scale-out of the older revision could not start; and Fargate bounds
a container dependency's wait at 120 s, which a long migration would outrun.

ECS pause hooks may offer a later shape: at `PRE_SCALE_UP` the deployment waits until Control has run the migration
once as a `RunTask` and calls `ContinueServiceDeployment`; a hook waits up to 14 days
([pause hooks](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/pause-lifecycle-hooks.html)). The docs show
them with blue/green deployments; whether they work with a rolling update was not confirmed. Take it with the second
version, after a live check.

### PostgreSQL: RDS, not Aurora

- **RDS for PostgreSQL 18, `db.t4g.small` Single-AZ ($0.037 an hour), Multi-AZ for HA (chosen).** Automated backups
  with point-in-time recovery, retention 0–35 days
  ([backup retention](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html)).
  The master user holds `CREATEDB` and `CREATEROLE` and is a member of `rds_superuser`
  ([rds_superuser](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Roles.rds_superuser.html)),
  which is what `provisionPostgresRoles` needs. `rds.force_ssl` is on by default from PostgreSQL 15
  ([SSL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Concepts.General.SSL.html)); the URL says
  `sslmode=verify-full&sslrootcert=<global-bundle.pem>`, with the bundle from
  `https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem` baked into the image (shared prerequisite N4).
- **Aurora Serverless v2 (rejected).** It now scales to 0 ACU after five idle minutes, but at $0.14 an ACU-hour it costs
  more than `db.t4g.small` once it is awake for about a quarter of the time, and an installation's services keep it
  awake (job leases, the Operations consumer). Aurora provisioned has no class as small as `t4g.small`.
- **`db.t4g.micro` ($0.019 an hour)** has 1 GB of memory and about 80 connections for three services and an
  application: too tight; `connection-capacity.ts` would have to budget against it.
- **One instance, many databases.** The cheap AWS shape is one instance per installation with a database per
  application (the shape of [A compact installation](compact-installation.md)); a `full` namespace gets its own instance.

### Files: S3

One private bucket per installation for platform data (run logs, Operations raw events and source maps) and one per
application environment. New buckets block public access and encrypt with SSE-S3 by default
([Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html),
[default encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/default-bucket-encryption.html)); the
provider adds versioning and a lifecycle rule that expires noncurrent versions after 30 days, which is the backup Zerops
does not have. S3 supports `If-None-Match` and `If-Match` on writes
([conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)). The task role's
credentials come from the container credentials endpoint and rotate, so the store needs the credential source of
shared prerequisite N5, and the application's storage must stop assuming `us-east-1` and path-style.

### Secrets: Parameter Store

Control writes an application's secrets as standard `SecureString` parameters under
`/fabrika/<installation>/<namespace>/<app>/<env>/`, and the task definition references them, so ECS injects them at
start; a changed secret takes effect on the next deploy, as on Zerops. Standard parameters cost nothing (10,000 of up to
4 KB; [tiers](https://docs.aws.amazon.com/systems-manager/latest/userguide/parameter-store-advanced-parameters.html)) and
the default 40 TPS is far above what deploys need. Secrets Manager ($0.40 a secret a month) adds rotation that
Fabrika does not use. The Control vault's key-encryption key can live in KMS ($1 a month) and never leave it.

### Networking and TLS

- One VPC in two availability zones, one internet-facing ALB ($0.027 an hour plus $0.008 an LCU-hour), ACM
  certificates validated by DNS records the operator adds, host rules sending each host to the platform proxy or a
  namespace proxy. The ALB appends `X-Forwarded-For`, so Caddy's `trusted_proxies` is the VPC range.
- Outbound internet (GitHub, ECR, the email provider, cron jobs with public egress): a public IPv4 address per task
  ($0.005 an hour each) with an ingress-free security group is cheaper than a NAT gateway ($0.052 an hour plus $0.052 a
  GB) up to about seven tasks; the regional NAT gateway is the answer for private subnets and for larger installations.
- Rule 5 of ADR-0022 (a namespace is one private network, the proxy secret authenticates the hop) maps onto security
  groups and becomes stronger: an application's port accepts connections only from its namespace proxy's group. The
  proxy reaches applications through Service Connect names.

### Infrastructure: CloudFormation

One template for the installation, applied by change set from `platform install` and `platform upgrade`; one stack per
namespace, which Control creates and updates over the CloudFormation API (ADR-0034). The stack's status is the
provisioning checkpoint, an update is reconcile, and the stack's resource list answers `claimedResources`. CDK and
Terraform would need a toolchain inside Control; the Cloud Control API has no stack-level rollback. Drift detection marks
the resource types it cannot check as `NOT_CHECKED`, so it is a report, not a gate.

### Email, cron, logs, identity

- **Email.** The existing adapters work unchanged (ADR-0019). An SES adapter (SES API v2 over HTTPS, $0.10 per 1,000
  recipients) needs a verified domain and production access (new accounts start in a sandbox of 200 messages a day,
  [production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)); bounces arrive as
  SNS or EventBridge events. Build it only when mail must stay in AWS.
- **Cron.** The serving process keeps cron wakes under the job leases (shared prerequisite N7). EventBridge Scheduler
  ($1.15 per million after 14 million free, 60-second precision, ECS `RunTask` as a target) is the fallback; it adds a
  role and a cold start per run.
- **Logs.** CloudWatch Logs ($0.63 a GB ingested, $0.0324 a GB-month stored) with a retention per log group; Control's
  run log relays the CodeBuild log and the ECS service events.
- **Identity.** The sidecar workflow assumes an IAM role through GitHub's OIDC provider
  ([OIDC providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_create_for-idp_oidc.html)). Control's
  task role may create and change only resources tagged as its namespaces, under a permissions boundary that keeps it
  off the installation's own resources: the AWS form of "reconcile refuses the installation's own project".

## Backups and point-in-time recovery

| What                           | AWS                                                                                                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                     | Automated backups, PITR to any second up to about five minutes ago, retention up to 35 days; free up to the provisioned storage, then $0.103 a GB-month |
| A restore                      | Creates a new instance: Fabrika needs a repoint step (new endpoint into the secrets, redeploy)                                                          |
| Before a destructive migration | `CreateDBSnapshot` from the provider's `backupBeforeMigrations` (shared prerequisite N11)                                                               |
| Files                          | Bucket versioning with a 30-day noncurrent expiry; AWS Backup for longer retention or a copy to a second region                                         |
| The backup view (backlog 212)  | `DescribeDBInstances` returns the retention and the latest restorable time                                                                              |

## The checklist

### A. Shared prerequisites

All of [the shared list](cloud-providers.md#the-shared-prerequisites) except N6 (the Azure blob store); N1 to N5 and N7
are in `main`. For AWS in particular: N2's part writer is an S3 multipart upload (parts of 5 MiB to 5 GiB, at most 10,000,
[quick facts](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html)); N3's image is `linux/arm64` with
the RDS bundle; N5's credential source reads the container credentials endpoint
(`AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`).

### B. The AWS package, in order

1. **`packages/provider-aws/`**: `package.json` (`@fabrika/provider-aws`, private until it can deploy, then public),
   `CLAUDE.md`, the three `tsconfig` files and the root `tsconfig.json` reference; the subpath `.` first, `/cli` and
   `/installation` once they do something.
2. **`src/codecs.ts`**: the target envelope (account, region, cluster, service), the artifact (the contract only; no
   manifest file), the namespace target, and the run checkpoint `{ buildToken?, buildId?, taskDefinitionArn?,
   serviceUpdateRequested?, deploymentArn? }`: a caller-chosen value before each submitting call (ADR-0044), each
   parsed with a schema and under Control's 16 KiB.
3. **`src/authoring.ts`**: `defineApp({ id })` returning a config `authoredAppProvider` reads as `aws`.
4. **`src/aws/`**: the clients for ECS, CodeBuild, ECR, SSM, CloudFormation, RDS, CloudWatch Logs and S3, with fakes
   for tests, without the AWS SDK
   ([ADR-0081](../decisions/0081-the-aws-provider-calls-aws-without-the-sdk.md)): a SigV4 signer of its own pinned with
   known-answer tests, JSON clients for ECS, CodeBuild, ECR, SSM and Logs, `Bun.S3Client` for S3, and a strict
   minimal XML reader for CloudFormation and RDS.
5. **`src/aws/s3.ts`** (built): the S3 multipart part writer Control's source client takes (N2's `SourcePartWriter`)
   and the presigned GET the build reads. The bucket that holds the sources, with a lifecycle rule that expires them and
   aborts incomplete uploads, is the namespace stack's (step 10).
6. **`src/build.ts`** (built): `StartBuild` with `NO_SOURCE` and one constant inline buildspec (fetch, unpack, write
   the rendered `Dockerfile`, build, push under the run's tag), every value of a run a build variable. The deploy reads
   the digest from ECR by that tag, never from the log. The build log relay (`aws/logs.ts`) and `StopBuild` on cancel
   (`run-attempt.ts`) are step 8's.
7. **`src/ecs-task.ts`** (built): the service's definition, the server container alone (image by digest, port, health
   check on the contract's health endpoint, log configuration), and a one-off init definition for the init commands of
   `containerImage` (N3, built), which step 8 runs once per command (`RunTask` with a command override, in order) before
   the service update, never in every service task: the schema check would fail an older revision's tasks against a
   newer schema. The environment and `secrets` by parameter ARN, a framework credential never plain; the task and
   execution roles. Assembling the managed environment is the deploy step's (step 8). Both roles are the application environment's own and never the same role (ADR-0004's AWS
   invariant): the execution role may read only its parameter path (`ssm:GetParameters`), write only its log group
   and pull only its repository, because with the `aws/ssm` key that scope is the only boundary between two
   applications' secrets. Whoever provisions the roles (the namespace stack, step 10) creates them per application
   environment, never one shared execution role.
8. **`src/deploy.ts`** (built): the run's steps (repository, upload, build, register, the init tasks, update the
   service, wait for the deployment) over the shared run's `runDeploy` and `awaitSettlement`, each external id recorded in the checkpoint before the call that needs it; `succeeded` only when the
   deployment is `SUCCESSFUL`, `failed` when the circuit breaker rolled back. Read that verdict from the service
   deployment (`DescribeServiceDeployments` by the checkpoint's `deploymentArn`), not from `DescribeServices`: once a
   rollback finishes, ECS drops the replaced deployment from the service's `deployments`, so a run read there would look
   absent, not failed (unverified against an account). `describeService` stays for the events the run log relays. ECR's lifecycle rule
   (`keepNewestImages`) counts pushes, not deployments, so builds pushed after the running image can expire it, and ECS
   can then neither replace a task nor roll back to it: size `keep` against that, or give the deployed digest an extra
   tag a separate rule keeps. The presigned URL reaches the build as a SecureString the deploy writes before the start
   and deletes once the build ended, under a name that is a function of the run (its build token), so the build role
   needs `ssm:GetParameters` on the runs' path only and a start records the name alone. `StartBuild`'s idempotency
   token holds five minutes, and a repeat must send the identical body: a start whose answer was lost is settled by
   `findBuild` (the token travels as `FABRIKA_BUILD_TOKEN`), never by a blind repeat; a `findBuild` that answers `null`
   for a lost start fails the run.
   The candidate is `src/run-attempt.ts`, the shared run's `RunAttempt`. What the steps are handed (the rendered image,
   the task's environment and secrets, the clients, Control's source upload and the run's `startedAtMs`) is step 9's
   to assemble; its `reconcile` and `cancel` build the attempt with the run's source URL parameter, so a discard after
   a crash deletes it. A cancelled or abandoned run does not stop an init task that is running: the migration runs to
   its end under the application's migration lock, which a later deploy's migration waits for. Not yet
   relayed: the service's own events during the rollout (`describeService` reads them).
9. **`src/control.ts`** (built, first part): the `ControlProvider`'s `resolveSource`, `deploy`, `cancel` and
   `reconcile` (the last two through the shared run), and `validateAccess`, which refuses before publication a contract
   with a database, jobs or files; `deploy` refuses it again before any call, as it does a dev environment.
   - **Names.** The target holds only what the installation shares: account, region, cluster, sources bucket (until
     step 10 creates them). Those are Control's own configuration (`FABRIKA_AWS_ACCOUNT_ID`,
     `FABRIKA_AWS_REGION`, `FABRIKA_AWS_CLUSTER`, `FABRIKA_AWS_SOURCES_BUCKET`), never a
     registrant's: `normalizeRegistration` replaces a submitted target with them, and `validateAccess`, `deploy`,
     `cancel` and `reconcile` refuse a stored target that differs. Every resource of one environment is derived from its application id and
     environment (`awsEnvironmentResources`), never registered, so no registration can aim a deploy, which Control
     signs with its own role, at another environment's resources: the service `<app>_<env>`, the repository
     `fabrika/apps/<app>/<env>`, the parameter path and log group `/fabrika/apps/<app>/<env>`, the roles
     `role/fabrika/apps/<app>_<env>_task`, `…_execution` and `…_build`, the build project `fabrika_<app>_<env>` with
     its log group `…/build`, the stack `fabrika-app-<length of app>-<app>-<env>`. An id or name holds no `_`, `/` or `.`, so no two
     environments derive one name. In the shared bucket an environment's archives live under `sources/<app>/<env>/`;
     a build start overrides only the buildspec, its variables (the derived repository, the run's URL parameter under
     the environment's path) and the timeouts, never the project's role, image or source.
   - **Secrets.** The secrets and managed credentials are the run's own parameters (`<path>/env/<runId>.<NAME>`),
     written before the steps, so no write touches a parameter a live revision reads. A run that did not ask for the
     update deletes its own, also when it throws or is cancelled (a `finally`, under its own bound), and a discard
     after a crash deletes them too; one that asked keeps them, because the update may still land. A successful run
     deletes those of every earlier run but the newest `AWS_KEPT_SECRET_RUNS` (2), which a rollback's revision may
     read. Run ids are UUIDv7, whose text order is their time order. UNVERIFIED: AWS documents a quota of 10,000
     standard parameters per account and region. An environment holds up to four runs' copies (this one, two kept, one
     whose update was asked and may still land), so with `s` secrets and managed credentials each it takes up to `4s`
     parameters, and an account fits about `2500 / s` environments. Step 10 sizes against that, or moves to the
     advanced tier.
   - **Limits.** Tasks get fixed sizes (`AWS_TASK_CPU`, `AWS_TASK_MEMORY`); the build has no SPA commands, no source
     maps and no runtime packages. The build's URL is signed with a fresh read of the container credentials, and a set
     that expires before it fails the run before the build.
   - **Not yet:** `secrets` (`PutParameter`, `DeleteParameter` per request), `declaredVariables`, `lockfileRefusal`, the `backupBeforeMigrations` snapshot. No `devSandboxes`,
     `dataOperations` or `authoring` in the first version.
10. **`src/environment-stack.ts`** (built, the template): each application environment's own stack,
    `awsEnvironmentStack`: its repository, its two log groups, its task role (no permission yet), its execution role
    (pull its images, write its log group, read its `env/` parameters) and its own build project with a build role
    (push to its repository, read its `builds/` parameters, write its build log group). Every trust policy names its
    service and the account (`aws:SourceAccount`). The deploy builds in the environment's project, so no application's
    build steps hold a role that reaches another environment. Not yet: applying the stack (a CloudFormation client,
    `CreateStack`/`UpdateStack`, deciding absence from `ListStacks`), the service itself, and the network below.

    **`src/namespace/`**: the namespace stack (security groups, the Service Connect namespace, the proxy service, the
    ALB rule and certificate; for `full` an RDS instance), the database per application in the shared instance for
    `cheap`, `claimedResources` from the stack, and the proxy manifest carried in the proxy's build as on Zerops
    (ADR-0045), so a running proxy never reads a manifest newer than its image. CloudFormation answers a missing stack
    with `ValidationError`, which only its message tells apart from a malformed call, and the query client never reads
    a message: decide a stack's absence from `ListStacks` (or a `DescribeStacks` by the stack's id, which keeps
    answering a deleted stack), never from that error.
11. **`src/installation/`**: the CloudFormation template rendered from the installation model (N9), `platform install`,
    `plan`, `deploy`, `upgrade` and `admin`, the GitHub OIDC role, Control's role with its permissions boundary, the
    sidecar workflow, and an operator guide. Control's role is scoped by the prefixes step 9 derives its names under,
    so AWS refuses what the code would never ask, and an application's own roles cannot be named outside them:
    - ECS: `UpdateService`, `DescribeServices`, the service deployment and revision reads, `RunTask`, `DescribeTasks`
      on `service/<cluster>/*` and `task/<cluster>/*`; `RegisterTaskDefinition` (no resource scope in ECS), with
      `iam:PassRole` only on `role/fabrika/apps/*` and the condition `iam:PassedToService = ecs-tasks.amazonaws.com`.
    - ECR: the repository calls on `repository/fabrika/apps/*`.
    - SSM: `PutParameter`, `DeleteParameter`, `DescribeParameters` on `parameter/fabrika/apps/*`.
    - CodeBuild: `StartBuild`, `BatchGetBuilds`, `StopBuild`, `ListBuildsForProject` on `project/fabrika_*`.
    - CloudWatch Logs: the reads on `log-group:/fabrika/apps/*` (the build log groups are below it).
    - S3: `PutObject`, the multipart calls and `GetObject` (the presigned read) on `<bucket>/sources/*`.
    - CloudFormation, for the environment stacks of step 10: the stack calls on `stack/fabrika-app-*`, and
      `iam:PassRole` on `role/fabrika/apps/*` to `codebuild.amazonaws.com` too.

    An application's build steps run with its environment's build role (step 10), which reaches only that
    environment's repository, `builds/` parameters and build log group, so no build reaches another application's
    images or sources.
12. **`packages/control/src/aws/`** (built): the composition root over the neutral Bun host (`provider.ts`, the server,
    maintenance and migration entries), and `entrypoint-isolation.test.ts` extended to it. It reads
    `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` (set by ECS), `FABRIKA_AWS_BASE_IMAGE` (the pinned Bun image) and the
    five installation coordinates of step 9, and
    reads repositories through the unbound GitHub source. Nothing runs it until step 11 defines Control's task.
13. **Tests**: the conformance suite over a fake AWS, renderer tests, and a live suite gated on
    `FABRIKA_LIVE_AWS_*` that creates and deletes a throwaway stack.
14. **Docs**: `docs/reference/aws-platform.md` for the facts a live account settles, an ADR for the provider's shape,
    `provider-bundles.md` and `installing-on-aws.md`.

## Effort

Person-days of one engineer working the way this repository is built (with agents), ±30 %. For calibration: the Zerops
provider is about 15,000 lines of source and 20,000 of tests, and its platform facts were each paid for with a live run.
AWS is better documented, so fewer facts need discovering, but it hands over less: the network, the balancer, TLS and the
build image are Fabrika's to declare.

| Part                                                                                                    |    Parity | First usable |
| ------------------------------------------------------------------------------------------------------- | --------: | -----------: |
| Shared prerequisites ([the comparison](cloud-providers.md#effort)), once for every cloud                |     22–35 |        20–33 |
| Provider skeleton, codecs, `defineApp`, conformance harness over a fake AWS                             |       3–4 |            3 |
| AWS client layer and fakes                                                                              |       4–6 |            4 |
| Build: multipart source, CodeBuild, ECR, source maps, log relay                                         |       4–6 |            4 |
| Deploy: task definitions, init task, rollout, rollback, checkpoint, reconcile, cancel                   |      6–10 |            6 |
| Secrets and the managed environment                                                                     |       2–3 |            2 |
| PostgreSQL on RDS: roles, connection budget, snapshot before migration, restore and repoint runbook     |       3–5 |            3 |
| Namespaces: presets, security groups, Service Connect, namespace proxy, ALB rules, certificates, claims |      8–12 |  4 (`cheap`) |
| Installation: CloudFormation, install/deploy/upgrade, least-privilege IAM, OIDC sidecar, guide          |     10–15 |            7 |
| Email (SES adapter), backup view, observability                                                         |       3–5 |            0 |
| Live bring-up on a real account, `aws-platform.md`, ADR                                                 |      8–12 |            6 |
| **AWS package total**                                                                                   | **51–78** |     **≈ 39** |

"First usable" is one installation running one application in a `cheap` namespace, with the ALB hosts, DNS and
certificates set by hand, mail through an existing adapter and no console form: about 20–33 days of shared
prerequisites (all but the console form, N10) plus about 39 of AWS, three to four calendar months for one person. The shared part is paid once:
the second cloud starts from it.

## Running cost of one small installation

List prices read on **2026-11-24** from the AWS Price List API (eu-central-1 offer files published 2026-11-06 to
2026-11-23), pay-as-you-go, no Savings Plans or reservations. A month is 730 hours. The workload is the one of
[the comparison](cloud-providers.md#running-cost-of-one-small-installation): IAM, Control, Operations, the platform proxy
and one namespace proxy at 0.25 vCPU and 0.5 GB, the application at 0.5 vCPU and 1 GB, all always on; PostgreSQL for the
platform, Operations and the application, each under 10 GB; 50 GB of files, 5,000 emails, 5 GB of logs, 20 GB out.

| Item                      | Configuration                                        | Unit price                       |       USD |
| ------------------------- | ---------------------------------------------------- | -------------------------------- | --------: |
| Fargate ARM               | 1.75 vCPU, 3.5 GB, always on                         | $0.03725/vCPU-h, $0.00409/GB-h   |     58.04 |
| Application Load Balancer | one, about 1 LCU                                     | $0.027/h, $0.008/LCU-h           |     25.55 |
| RDS for PostgreSQL        | `db.t4g.small` Single-AZ, 20 GB gp3, three databases | $0.037/h, $0.137/GB-month        |     29.75 |
| Public IPv4               | six task addresses and the ALB's two                 | $0.005/IP-h                      |     29.20 |
| CloudWatch Logs           | 5 GB ingested and stored                             | $0.63/GB, $0.0324/GB-month       |      3.31 |
| S3                        | 50 GB, ~100k PUT, ~1M GET                            | $0.0245/GB-month                 |      2.20 |
| KMS, ECR, Route 53, SES   | one key, 5 GB of images, one zone, 5,000 emails      | $1, $0.10/GB, $0.50, $0.10/1,000 |      2.50 |
| CodeBuild                 | 30 builds of 5 minutes, ARM small                    | $0.00385/min                     |      0.58 |
| Parameter Store           | standard parameters                                  | $0                               |         0 |
| Backups (PITR, 7–35 days) | free up to the provisioned storage                   | $0.103/GB-month beyond           |         0 |
| Outbound traffic          | 20 GB, inside the free 100 GB                        | $0.09/GB beyond                  |         0 |
| **Total**                 |                                                      |                                  | **≈ 151** |

Against Zerops (about $27 single-node, $85–146 HA, 2026-11-11 figures) AWS is five to six times more for the small
shape; its fixed costs are the balancer and the public addresses or a NAT gateway. HA (Fargate doubled, a regional NAT
gateway, `db.t4g.medium` Multi-AZ) was about $365 on 2026-11-11 and was not re-priced. The single-EC2 shape stays the
honest cheap AWS answer at about $71.

## Risks

- **Cost of the floor.** An AWS installation has fixed monthly costs (balancer, database instance, addresses) that
  Zerops does not, and every extra database instance is a visible line.
- **One more provider to keep current.** Every change to the delivery path, the managed environment or the proxy is
  made and verified once more. A provider without a live installation is untested by definition
  (compare [`cloudflare-platform.md`](../reference/cloudflare-platform.md)).
- **IAM is a security boundary Fabrika has not owned before.** Control's role must create namespaces and must not touch
  the platform. A mistake there is worse than on Zerops, where the token's reach is one project.
- **No faithful local emulator.** Tests run against fakes; the facts come from a live account, which costs money while
  it runs.
- **Slower feedback.** A stack update, an image build and a rollout each take minutes; the MCP authoring loop (dev
  sandboxes on Zerops Box) has no AWS counterpart in this plan.
- **Requirements beyond the region**: the operator's own account, a landing zone, private connectivity, or the
  European Sovereign Cloud. "Install into the operator's account" is a supported shape (ADR-0025); each of the others
  is extra work.

## Open questions before any code

- Do pause hooks work with an ECS rolling update, or only with blue/green?
- How long do ECS task-role credentials live, and does `Bun.S3Client` take a refreshed set without being rebuilt?
- Does `provisionPostgresRoles` run unchanged as the RDS master user? (Expected yes; first live check.)
- Will the first AWS installation live in the operator's own account? That decides whether `platform install`
  creates the VPC or adopts one.
- Which services does the European Sovereign Cloud offer today? No official list was found.
