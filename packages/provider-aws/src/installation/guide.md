# Installing Fabrika on AWS

**Under construction.** No installation has run this yet; the first run against an account is the provider's live
check. The commands below make an installation's infrastructure and services, register the console with IAM and
admit the first administrator.

## What you need first

1. **An AWS account and a region, and administrator access in that account.** The run creates IAM roles and
   policies (under `/fabrika/`), which is as much as an administrator's power, so a narrower policy buys nothing. It
   creates: two VPCs with their subnets and gateways, two load balancers, an RDS PostgreSQL instance, ECS clusters,
   services and task definitions, a Service Connect namespace (Cloud Map), CodeBuild projects, ECR repositories,
   CloudWatch log groups, a Lambda function, S3 buckets, Parameter Store values, CloudFormation stacks, and the ECS
   service-linked role on a fresh account. Export your credentials as the standard variables:
   `eval "$(aws configure export-credentials --format env)"`. The run checks first that they are the account you name.
2. **Four hosts and their certificates in that region** (ACM, DNS-validated, each for exactly its host): IAM's,
   Control's (the console), Operations', and the applications' listener's default host. Request each with
   `aws acm request-certificate --domain-name <host> --validation-method DNS`, add the record it names, and wait
   until it is `ISSUED`.
3. **The release**: its full commit id (`git rev-parse <tag>^{commit}` in your checkout of the release's tag), and
   the Bun image applications build from, by digest (`docker.io/oven/bun@sha256:...`).

## Install

```bash
fabrika platform install --provider=aws \
  --account-id=<12 digits> --region=<region> --environment=production \
  --iam-host=<host> --iam-certificate=<ARN> \
  --control-host=<host> --control-certificate=<ARN> \
  --operations-host=<host> --operations-certificate=<ARN> \
  --apps-host=<host> --apps-certificate=<ARN> \
  --commit=<40 hex> --base-image=<image@sha256:...>
```

It records these choices in the account (`/fabrika/platform/installation/record`), asks once, then applies the
platform's stacks in order, builds the release's two images, runs the database setup and starts the services. It
takes most of an hour, the database most of it. A run that stops part way (a stack still settling, a refused call)
is finished by running the same command again, with the same choices. One that stopped once its services were being
created is finished by `platform upgrade` instead (below), which the install's refusal says.

People sign in with a password unless you name `--auth-methods`. OIDC takes `--oidc-issuer`, `--oidc-client-id` and
`FABRIKA_IAM_OIDC_CLIENT_SECRET` in the environment. Mail takes `--email-provider` and its variables.

## Point the hosts

The run ends by naming the platform balancer's DNS name. Point IAM's, Control's and Operations' hosts at it (a CNAME,
or an alias record in Route 53). The applications' hosts go to the applications' balancer, named in the CloudFormation
stack `fabrika-platform-balancers`'s outputs.

## Admit the first administrator

Once the hosts resolve to the balancer:

```bash
fabrika platform admin --provider=aws --account-id=<12 digits> --region=<region> --email=<address>
```

It registers the console and IAM's own vocabulary with IAM, then admits the address as the first administrator. IAM's
provisioning key is read from the installation, never typed. Without a mail service it prints an enrollment URL that
sets the first password: a credential, printed once and stored nowhere, to hand to that person yourself. Running it
again admits nobody twice; `--reissue` replaces an enrollment that expired unopened.

## Keep the keys

The installation's generated keys exist only in Parameter Store, under `/fabrika/platform/<service>/`. Losing
Control's vault key (`/fabrika/platform/control/FABRIKA_CONTROL_VAULT_KEY`) loses every application's secrets, and
losing IAM's signing keys ends every session. Copy them, and the database's passwords under
`/fabrika/platform/database/`, to the password manager you keep such things in. This prints every one of them:

```bash
aws ssm get-parameters-by-path --path /fabrika/platform/ --recursive --with-decryption --output json > fabrika-keys.json
```

Its output is every secret of the installation. Write it to a file you move into the password manager and then
delete, never to a terminal whose scrollback is logged or a shell history that others read. An upgrade refuses to run
with a key missing rather than make a new one.

## Upgrade

The account, the region and the new release; every other choice is the installation's own, read from its record:

```bash
fabrika platform upgrade --provider=aws --account-id=<12 digits> --region=<region> \
  --commit=<40 hex> --base-image=<image@sha256:...>
```

It builds the release's images (or finds them built), runs the database setup before any service moves, rewrites what
the release derives, rolls the services, and registers the console's vocabulary with IAM again, since a release may
change it.

The record (`/fabrika/platform/installation/record`) is in the keys' backup above. If it is lost, restore it from
there, or run the upgrade naming every choice the install named (ranges included, which must be the networks' own):
it writes the record back. A sign-in method or a mailer you changed by hand stays as you set it.
Name a certificate (`--control-certificate=<ARN>`, after renewing it under a new ARN) or `--mcp-authoring` to change
it; the run names the change before it asks. A changed network range, host or environment name is refused: those
would replace the networks or rewrite what every service derives.
