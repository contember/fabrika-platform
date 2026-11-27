---
id: 0092
title: The platform installation is a model each provider renders and applies
status: proposed
date: 2026-11-27
---

# 0092: The platform installation is a model each provider renders and applies

## Context

A platform installation is four services (IAM, Operations, Control and the platform proxy), the databases and buckets
they keep their state in, and the public hosts the proxy answers. [ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md)
makes the operator its owner and `fabrika platform install|deploy|upgrade` the commands that bring it up and move it;
[ADR-0027](0027-platform-deploy-is-as-wide-as-the-provider-needs.md) lets each provider's `deploy` own the order.

What those four services ARE is stated today once per provider, in that provider's own format:

- **Zerops**: `provider-zerops/src/installation/topology/setups.ts` (the root `zerops.yaml`: ports, `/healthz`, the
  migrate and start commands, each crontab, the private addresses `http://iam:3000` and its neighbours) and
  `topology.ts` (the import documents: which data services exist, the order by `priority`, the one public service).
- **AWS**: `provider-aws/src/installation/services.ts` restates the same facts as CloudFormation (`SERVICE_COMMANDS`,
  `FIXED_VARIABLES`, port 3000, `/healthz`, a job loop per service), and `database.ts` and `runtime.ts` restate which
  service owns which database and bucket and who calls whom.

`@fabrika/installation-init` already holds the neutral half of the environment: `installationServiceEnvironment` and
`deployedServiceEnvironment` name every variable each service reads, with the data coordinates "in the provider's own
spelling". The rest is copied. A third cloud ([Azure](../ideas/azure-provider.md) renders Bicep,
[Google Cloud](../ideas/gcp-provider.md) Terraform) would copy it a third time, and a copy that drifts (a new variable,
a changed job schedule) breaks one cloud's installation silently.

Two further forces shape the decision:

- **One tool must not be assumed.** An operator may want the installation's infrastructure in their own Terraform (or
  OpenTofu), next to or instead of the CloudFormation, Bicep or Terraform fabrika renders. A model that is secretly one
  tool's template cannot serve that.
- **Not everything an installation needs is the same on every cloud.** A network, a balancer, a cluster, task roles,
  instance sizes and a Zerops `corePackage` have no counterpart elsewhere. A model that tried to hold them would be a
  union of every cloud's options.

## Decision

We will describe the platform installation as data, the **installation model**, and give each provider a **renderer**
that turns the model into its own infrastructure format and an **applier** that `platform install|deploy|upgrade`
runs. The model is the neutral half; the renderer and the applier are the provider's.

### 1. The model

A plain, typed value built by `platformInstallationModel(input)` in `@fabrika/installation-init` (its `model.ts`, from the
package's root export). It is built in memory by the release that renders it and never persisted, so it carries no
envelope ([ADR-0011](0011-static-provider-bundles.md): envelopes only where data is persisted). It holds:

- **Services**, `iam`, `operations`, `control` and `proxy`, each with:
  - `artifact`: which of the release's two build outputs runs it, the workspace (`services`) or the proxy's own
    (`proxy`). How the provider produces it (a Zerops build setup, an image from a Dockerfile) is the provider's.
  - `ports`: each named, with its number and whether it speaks HTTP; the proxy's health listener is a port of its own.
  - `health`: the port and path of liveness and readiness (`/healthz`). Probe timings are the provider's; a service
    with a migrate command gets the longer start allowance its migrations need.
  - `entry`: the migrate command, if any, and the server command, as paths inside the artifact. Control's are its
    provider composition root's (`packages/control/src/<cloud>/`), so the provider passes them to the builder. The
    proxy has none: its artifact starts itself.
  - `jobs`: each scheduled job's command and schedule, a five-field cron expression in UTC, each field in its range
    (what Zerops' crontab, a Kubernetes `CronJob` and a Container Apps job take; a renderer for EventBridge Scheduler,
    whose `cron()` has six fields, translates it). **A job runs once per schedule across the service's instances**:
    Zerops writes `allContainers: false`, a `CronJob` gives it, and a renderer that scales a service must keep it. A
    renderer that runs a job as a loop beside each task keeps it only while the service runs one task, and keeps an
    interval, not a time of day: it accepts every minute, every N minutes for an N that divides 60 (cron restarts the
    count each hour, so another N matches no fixed interval), and `M H * * *` only as every 24 hours from the task's
    start, and refuses the others. So no job may rely on the hour it runs at.
  - `calls`: the services it dials over the private network. A renderer derives its network rules from them (AWS
    security groups, Kubernetes network policies).
  - `environment`: every variable it reads, by name, each with a **kind**, whether it is sensitive, and a
    **condition** where it is written only when the installation uses what it configures (the `OIDC_*` variables with
    OIDC on, the mail transport's with a mail provider, `FABRIKA_IAM_OAUTH_CONFIG` and
    `FABRIKA_OPERATIONS_OAUTH_RESOURCE` with OAuth over https, a provider's variable with that provider's option). A
    renderer or an applier writes a conditional variable only when its condition holds; a deploy without it leaves the
    variable as it is (so the manifest, whose rows then admit no OAuth token, is what turns OAuth off). The kinds:
    - `fixed`: true for every installation (`PORT`, an asset directory), with its value;
    - `address`: another service's private address (`FABRIKA_IAM_RPC_URL` is `iam`'s), spelled whole by the renderer,
      scheme and port included (Zerops and AWS write `http://<service>:<port>`; a cloud that reaches a service at an
      ingress or an `https://` URL writes that);
    - `data`: one entry per store the service reads, naming the store and the variable (a database's DSN,
      `FABRIKA_IAM_DATABASE_URL`) or the prefix (a bucket's, `FABRIKA_CONTROL_RUN_LOGS`). The provider spells the
      variables under a prefix: Zerops writes a key pair and an endpoint; AWS writes a region and
      `_CREDENTIALS=container` and no key, because the task role signs;
    - `generated`: a secret the bring-up generates once. A generated variable names the **installation secret** it
      carries, and readers share the secret, not the name: IAM's `FABRIKA_IAM_PROXY_KEY` and the proxy's
      `FABRIKA_IAM_KEY` are one key. Each installation secret states whether an upgrade may generate it when no reader
      holds it: IAM's data key alone may. Any other one missing stops the run, because a new one would hide a loss: a
      new vault key orphans every application's secret. A provider's own generated variable may name no installation
      secret: a credential the provider makes for itself at install (Zerops' integration token for Control), which an
      upgrade never makes;
    - `bring-up`: the operator's choice at install, written once and never by a deploy (the sign-in methods, the mail
      transport);
    - `derived`: computed by every deploy from the placement (where the installation answers), the release it deploys
      and the generated values, and rewritten by it (`ISSUER` from the placement, the console table's digest from the
      release, and the IAM proxy secret from the provisioning key, which makes it sensitive).
      The model holds names, kinds, conditions and fixed values only. The values of the other kinds stay where they
      are produced today, in `installationServiceEnvironment` and `deployedServiceEnvironment`, and reach the services
      through the applier. A test holds the names of the kinds those two functions write (`data` outside its prefixes,
      `generated`, `bring-up`, `derived`) equal to the names they write, with every condition on and off.
    - **A provider's own variables** sit beside the model's, each declared with a kind from the same list and passing
      the same checks: Control's cloud coordinates (`FABRIKA_ZEROPS_*`, `FABRIKA_AWS_*`), or a provider's name for a
      shared generated value (`FABRIKA_AWS_PROXY_IAM_KEY` carries IAM's proxy key). The renderer and the applier treat
      them as the model's, so no provider keeps a second list of kinds.
  - `public`: true on the proxy alone. The builder refuses a model with another public service
    ([ADR-0022](0022-the-proxy-is-the-only-enforcement-point.md)).
- **Databases**, logical: `iam`, `control`, `operations`, each owned by one service. They may share a server: their
  tables are disjoint and each keeps its own migration ledger and lock ([ADR-0017](0017-service-owned-postgres-migrations.md)).
  Which server holds which (Zerops' `db` and `operationsdb`, one RDS instance with three databases) is the provider's
  placement.
- **Buckets**, logical: Control's run logs and Operations' blobs, each owned by one service. Their key prefixes are
  disjoint, so they may share a physical bucket (Zerops' light tier does).
- **Public hosts**: IAM's, Control's (the console) and Operations', each routed to the proxy, from `PlatformHosts`.
- **The order's constraints**, not a sequence:
  - a service starts after the services it calls exist; where `calls` form a cycle (IAM and Control dial each other),
    the applier closes it;
  - no new code serves behind an older proxy manifest, and the manifest is applied in the same run as the code it
    describes (ADR-0027's invariant);
  - a provider's database setup (users, databases, grants), where it has one, runs before any service moves.

  Each applier keeps them in its own sequence. Zerops builds IAM and Operations at once, then the proxy, then
  Control. AWS runs the setup, rolls the three services in one stack update, creates the proxy after them (a Service
  Connect task resolves only the endpoints that existed when it deployed) and, on a fresh install, redeploys once the
  services that dial each other.

The model holds no provider's spelling (no hostname of a data service, no logical id, no `Ref`, no ARN), no size, no
network and nothing about application namespaces. A namespace's and an environment's runtime resources stay Control's,
created at runtime by the provider's namespace capability ([ADR-0014](0014-provider-owned-deployment-namespaces.md)).

### 2. Renderer and applier

A provider's installation has two parts with one boundary between them:

- **The renderer** takes the model and the provider's own options (Zerops: the tier and how the proxy is published;
  AWS: the address ranges, the hosts' certificates) and returns the provider's documents: files to commit or apply
  (Zerops' import documents and root `zerops.yaml`; Terraform's JSON syntax later) or documents applied by API (AWS's
  CloudFormation stacks). It is a pure function: no I/O, no clock, no randomness, so its output is pinned by a test,
  byte for byte.
- **The applier** does everything with a side effect: the import, the change set, the environment writes, the build
  triggers, the waits, the order. It is what `platform install|deploy|upgrade` run, as each provider runs them today.
  It returns the **coordinates**: the provider's typed record of where the infrastructure it applied is (on AWS the
  VPC and subnet ids, the balancers' listeners and target group, the database endpoint and client group, the buckets,
  the Service Connect namespace; on Zerops the project and its services' ids).

A provider's installation is in two layers, and the renderer has a function for each:

- **Infrastructure**, which outlives a release: networks, balancers, database servers, buckets, clusters, roles. Its
  renderer needs the model and the options.
- **Release**, which every `deploy` and `upgrade` moves: the services at one version (images or archives, task
  definitions or setups), their environment, the database setup where a provider has one (it runs on every upgrade),
  the order, the manifest. Its renderer needs the model, the options and
  the infrastructure's coordinates.

**Invariant: a renderer is a pure function of the model, the provider's options and, for the release, the
coordinates; it reads no secret value, and nothing it renders holds one.** A secret reaches a service only through the
applier, by the provider's secret mechanism (Zerops' sensitive variables, AWS's Parameter Store).

### 3. Infrastructure the operator owns

An operator who manages the infrastructure with their own tool does not run fabrika's infrastructure renderer. They
hand fabrika the coordinates instead, and fabrika applies only the release onto them:

- Each provider defines its coordinates' schema, read strictly and versioned as `{ provider, version, payload }`,
  because they cross from outside fabrika. A missing or extra field, another provider or another version fails closed.
- From Terraform (or OpenTofu), the operator's root module exposes **one output, `fabrika_coordinates`**, whose value
  is that whole envelope. The reader takes what `terraform output -json` prints, picks that output by name, reads its
  `value` strictly, and ignores the root module's other outputs, so an operator's module may output whatever else it
  needs.
- **Coordinates never carry a secret value.** They hold where a credential lives (a parameter's name, a secret's ARN),
  never the credential: the applier resolves the reference through the provider's secret mechanism, so the
  renderer's invariant below holds for the release too. The reader refuses an output marked `sensitive`, because
  `terraform output -json` prints a sensitive output's value in clear. A credential fabrika needs and did not create
  (on AWS, the database's master user, whose password the install generates into Parameter Store today) is named by
  reference in the coordinates.
- The applier checks the coordinates against the cloud before it uses them (the resources exist and fit together, for
  example the subnets are in the VPC and the database answers from them) and changes nothing it did not render.
- The installation records where its coordinates came from, in the record it already keeps of the operator's choices
  (on AWS the installation record `install` writes and `upgrade` reads back). An installation set up from an
  operator's coordinates never starts rendering its infrastructure on an upgrade.
- The release layer, the order and the proxy manifest stay fabrika's in every case: ADR-0025 and ADR-0027 are
  unchanged.

### 4. Terraform fits without a change to the model

A Terraform (or OpenTofu) output for a cloud is one more renderer and applier: the renderer writes Terraform's JSON
syntax (deterministic, no HCL printer), the applier runs the tool against the operator's state backend and reads its
outputs through the same coordinates reader. The same rendered module is what an operator who owns their Terraform can
call from their own root module. No such renderer is built by this decision.

### Where the code lives

- The model and its builder: `@fabrika/installation-init` (`src/model.ts`), beside the environment it names.
- The Zerops renderer: `provider-zerops/src/installation/topology/`, which `setups.ts` and `topology.ts` become views
  of. `@fabrika/platform-artifacts` keeps writing and checking the committed files.
- The AWS renderer: `provider-aws/src/installation/`, whose stacks read the model instead of their own constants.
- Cloudflare is out of the model: its installation is Workers configured through oblaka, with no image, port or
  process, and its order lives in the operator's workflow (ADR-0027). A Cloudflare renderer would need its own
  decision.

## Consequences

- A service's port, health path, commands, jobs, private addresses and variables are stated once. Adding a variable
  or a job reaches every cloud's rendering, and a cloud that cannot express it fails its own test.
- A new cloud writes a renderer and an applier, not a fourth copy of the services.
- **Zerops changes nothing.** Its renderer must produce today's committed `zerops.yaml` and import documents byte for
  byte, which the existing drift tests already check (`platform-artifacts`' `gen:check`), and writes the same
  environment. On `platform upgrade` an existing installation therefore converges on nothing new: no generated file,
  variable or provider state changes, and no pin floats differently.
- AWS is private and installs nothing yet; its stacks are re-derived from the model with the same template content,
  in a change of its own after the work in flight on its install and upgrade commands lands.
- The model adds no protocol. The variable names in it are the ones `service-environment.ts` already pins as protocol
  ([ADR-0062](0062-a-platform-release-serves-older-framework-releases.md)); a rename there is still an upgrade step.
- Operator-owned infrastructure is a shape the code can take, not one it takes yet: no provider reads coordinates from
  an operator before a provider needs it. AWS decided (2026-11-26) to create its own VPCs, balancers and database; the
  coordinates it already reads from its stacks' outputs are the schema an operator's outputs will fill.
- What the model leaves to providers (sizes, tiers, probe timings, networks, build recipes) stays duplicated in
  spirit: each cloud decides it in its own terms, which is the point.

## Alternatives considered

- **Keep each provider's own statement of the installation.** No new abstraction, and the two existing ones work. It
  loses on the third cloud: the facts are already copied once (`setups.ts` and `services.ts` both carry
  `FABRIKA_IAM_RPC_URL: http://iam:3000`, the commands and the schedules), and every copy is a place a change is missed.
- **Terraform (or OpenTofu) as the one format for every cloud.** One renderer, one applier, and operators who already
  run Terraform would feel at home. It makes a Terraform binary and a state backend (with its own credentials) a
  prerequisite of every installation, replaces Zerops' proven import and environment path with an unproven one, and
  gives up CloudFormation's stack-level rollback on AWS, one reason the AWS provider chose it
  ([the AWS idea](../ideas/aws-provider.md#infrastructure-cloudformation)). Terraform stays one
  renderer a provider may offer.
- **A template as the model** (CloudFormation as the lingua franca, or a CDK or Pulumi program). A program is not
  data: it cannot be diffed, it ties the installation to a runtime and an SDK
  ([ADR-0081](0081-the-aws-provider-calls-aws-without-the-sdk.md) keeps the AWS SDK out), and a CloudFormation-shaped
  model would make every other renderer a translator of AWS's concepts.
- **A model that also holds the infrastructure** (networks, balancers, sizes, tiers), as a common denominator. Each
  cloud's network and sizing differ in kind, not in value, so the model would grow one optional field per cloud and
  the neutral half would stop being neutral.
- **A model that carries values, secrets included, so the renderer writes them.** It would let one function produce a
  complete document, and it would put credentials into files that are committed, logged or kept as a template body
  in the cloud's own history. Values stay with the applier.
- **Adopting operator-owned resources by discovery** (find the VPC or the database by tag) instead of explicit
  coordinates. It is implicit, ambiguous when two installations share an account, and fails in ways an operator cannot
  read. Explicit coordinates are checked and recorded.
- **Moving a namespace's runtime resources into the model.** They are created and reconciled by Control at runtime,
  per namespace and environment, through the provider's namespace capability; the installation's commands never touch
  them, and putting them in the model would give two owners one resource.
- **A package of its own for the model** (`@fabrika/installation-model`). It has no dependency or release boundary
  apart from `@fabrika/installation-init`, which both public provider packages already depend on, so by ADR-0013's rule
  it is a module there ([ADR-0013](0013-explicit-runtime-adapter-entrypoints.md)).
