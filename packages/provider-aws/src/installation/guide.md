# Installing Fabrika on AWS

**Under construction.** No installation has run this yet; the first run against an account is the provider's live
check. The commands below make an installation's infrastructure and services, register the console with IAM and
admit the first administrator.

## What you need first

1. **An AWS account of its own, a region, and administrator access in that account.** Give the installation an
   account that holds nothing else: the workflow that upgrades it later may change what other workloads in the same
   account run, which no permissions boundary prevents. The run creates IAM roles and
   policies (under `/fabrika/`), which is as much as an administrator's power, so a narrower policy buys nothing. It
   creates: two VPCs with their subnets and gateways, two load balancers, an RDS PostgreSQL instance, ECS clusters,
   services and task definitions, a Service Connect namespace (Cloud Map), CodeBuild projects, ECR repositories,
   CloudWatch log groups, Lambda functions, S3 buckets, Parameter Store values, CloudFormation stacks (the ceilings
   first: the permissions boundaries every platform role carries, which only your own credentials change), and the ECS
   service-linked role on a fresh account. Export your credentials as the standard variables:
   `eval "$(aws configure export-credentials --format env)"`. The run checks first that they are the account you name.
2. **Four hosts, and access to their DNS**: IAM's, Control's (the console), Operations', and the applications'
   listener's default host, which must be none of the other three. Each gets a certificate of exactly its host (ACM,
   validated by DNS, in the installation's region): the install requests them, and you add the records it prints.
3. **The release**: its full commit id (`git rev-parse <tag>^{commit}` in your checkout of the release's tag), and
   the Bun image applications build from, by digest (`docker.io/oven/bun@sha256:...`).

## Install

```bash
fabrika platform install --provider=aws \
  --account-id=<12 digits> --region=<region> --environment=production \
  --iam-host=<host> --control-host=<host> --operations-host=<host> --apps-host=<host> \
  --commit=<40 hex> --base-image=<image@sha256:...>
```

**The certificates first.** For each host the run takes the account's certificate of exactly that host (an
issued one before one waiting for its record, the newest of each); for a host with none it asks, then requests one. Until every one is issued it prints
the DNS records to add (`CNAME <name> -> <value>`) and stops before anything else. Add them, and keep them: ACM renews
each certificate with its record. Run the same command again once ACM has issued them (minutes, once the records
resolve); it finds the same certificates and goes on. To use a certificate you already have, name it
(`--iam-certificate=<ARN>`, and so on): it must be this account's and region's, of exactly its host, and issued.

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
change it. An upgrade that finishes an install whose hosts point nowhere yet cannot reach IAM: it says so and names
`platform admin`, which registers both once they do. An answer from IAM that refuses fails the run.

The record (`/fabrika/platform/installation/record`) is in the keys' backup above. If it is lost, restore it from
there, or run the upgrade naming every choice the install named, `--mcp-authoring` included: it writes the record
back. The ranges must be the networks' own, and the hosts and the environment's name the ones the installation holds,
or it refuses. A sign-in method or a mailer you changed by hand stays as you set it.
Name a certificate (`--control-certificate=<ARN>`, after renewing it under a new ARN) or `--mcp-authoring` to change
it; the run names the change before it asks. A changed network range, host or environment name is refused: those
would replace the networks or rewrite what every service derives. An upgrade requests no certificate: each one, the
record's or the one named, must be issued, so one that expired or was revoked is refused until you name another.

## Upgrade from GitHub (the sidecar)

From then on, a GitHub workflow can run the upgrade for you, in a private repository of your own, with no key stored
anywhere. With `gh` signed in (rights to create the repository) and your own credentials exported:

```bash
fabrika platform init --provider=aws --account-id=<12 digits> --region=<region> \
  --repo=<owner>/<name> --tag=<published tag> --base-image=<image@sha256:...>
```

It asks before each step:

1. It creates the repository, or refreshes it, with the workflow and `fabrika.ref`, which pins the release.
2. It sets the repository's OIDC subject to its numeric ids, and applies the deployer: the role AWS gives to a job of
   that repository running in the installation's GitHub Environment (named after its environment) alone.
3. It writes that Environment's four variables (the account, the region, the role's ARN, the base image). There is no
   secret to write.

To upgrade, bump `fabrika.ref` to a newer tag and push.

**Require a person to approve every upgrade.** The deployer is an administrator of the account inside the installation's
ceiling: it can make no IAM user, key or identity provider, can neither widen nor re-trust itself, and passes roles only
to the installation's services. Whoever can run the workflow in that Environment can still do what the platform's
stacks can. In particular, a role it makes may be given a trust pointing outside the account, and whoever takes it gets
the ceiling and no more. So add yourself as a required reviewer of the Environment (init prints the `gh` command), keep
it restricted to `main`, and keep the account for the installation alone: in an account shared with other workloads,
the deployer could change what they run.

A release that changes the ceilings (the boundaries every platform role carries) stops the workflow before anything
moves. Run that one upgrade yourself, with your own credentials; the workflow runs the next ones.
