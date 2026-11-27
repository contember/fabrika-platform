# Installing Fabrika on AWS

**Under construction.** No installation has run this yet; the first run against an account is the provider's live
check. The commands below make an installation's infrastructure and services. Admitting the first administrator and
registering the console's schema with IAM come in a later release.

## What you need first

1. **An AWS account and a region**, and your own credentials in it with the rights to create VPCs, load balancers,
   an RDS instance, ECS, CodeBuild, ECR, IAM roles under `/fabrika/`, Parameter Store values and S3 buckets. Export
   them as the standard variables: `eval "$(aws configure export-credentials --format env)"`.
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

It asks once, then applies the platform's stacks in order, builds the release's two images, runs the database setup
and starts the services. It takes most of an hour, the database most of it. A run that stops part way (a stack still
settling, a refused call) is finished by running the same command again.

People sign in with a password unless you name `--auth-methods`. OIDC takes `--oidc-issuer`, `--oidc-client-id` and
`FABRIKA_IAM_OIDC_CLIENT_SECRET` in the environment. Mail takes `--email-provider` and its variables.

## Point the hosts

The run ends by naming the platform balancer's DNS name. Point IAM's, Control's and Operations' hosts at it (a CNAME,
or an alias record in Route 53). The applications' hosts go to the applications' balancer, named in the CloudFormation
stack `fabrika-platform-balancers`'s outputs.

## Keep the keys

The installation's generated keys exist only in Parameter Store, under `/fabrika/platform/<service>/`. Losing
Control's vault key (`/fabrika/platform/control/FABRIKA_CONTROL_VAULT_KEY`) loses every application's secrets, and
losing IAM's signing keys ends every session. Copy them, and the database's passwords under
`/fabrika/platform/database/`, to the password manager you keep such things in. An upgrade refuses to run with a key
missing rather than make a new one.

## Upgrade

The same options without the install-only ones, and the new release's commit:

```bash
fabrika platform upgrade --provider=aws <the same options> --commit=<40 hex>
```

It builds the release's images (or finds them built), runs the database setup before any service moves, rewrites what
the release derives, and rolls the services. A sign-in method or a mailer you changed by hand stays as you set it.
