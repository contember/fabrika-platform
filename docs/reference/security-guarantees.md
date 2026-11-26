# Security guarantees: what fabrika prevents, what it limits, what stays yours

For whoever chooses, audits or runs fabrika for an organization: which security properties follow from the design,
what can still go wrong, and which part of the work stays with the organization. Each statement links to the code, an
ADR or the section of [`security-runtime.md`](security-runtime.md) or [`security-deployment.md`](security-deployment.md)
that holds its evidence; those two pages are the detail, this page is the summary. Like them, it describes this commit.

Three roles appear below. The **organization** owns an installation: its cloud account, its applications and its
people. The **operator** installs and upgrades it, usually the organization's own IT or a contractor. The
**developer** writes an application. fabrika is software the operator installs into the organization's own account;
nobody else runs it for them, and this repository promises no support or uptime. Support can be arranged by contract
with the authors. How to report a vulnerability, and which releases get fixes, is in [`SECURITY.md`](../../SECURITY.md).

## What follows from the design

1. **No application is reachable except through the proxy, and every endpoint says who may call it.** The proxy
   checks the caller against the endpoint's declared requirement before the application runs, and the application
   checks again that the proxy selected the same endpoint and that the token is for it. A mistake in the proxy's
   configuration alone does not make an application accept a request for another endpoint, or with less permission
   than the endpoint declares ([runtime §1–2](security-runtime.md#1-the-proxy-is-the-only-public-address)).
2. **Applications never handle a caller's password, session cookie or API key.** Sign-in, password reset and single
   sign-on happen in IAM. An application receives a token that is good for that one application in one environment,
   for at most five minutes ([runtime §3](security-runtime.md#3-identity-lives-in-iam-the-application-never-sees-a-persons-credential)).
3. **Data is scoped by default.** The data layer adds the caller's scope to every statement and refuses an unscoped
   query, so a forgotten filter fails instead of returning another department's rows. Raw SQL is possible only at a
   site the contract declares, and a new one waits for approval in production
   ([runtime §2](security-runtime.md#the-application-checks-the-proxys-word),
   [deployment](security-deployment.md#who-approves)).
4. **A change that steps off the paved road waits for a person in production.** New raw SQL, outbound calls, links
   that grant access, a procedure anyone may call, or a migration that may lose data is shown to someone holding
   `access.approve`, who approves it in the console ([deployment](security-deployment.md#who-approves)).
5. **One installation serves one organization.** Its IAM, databases, vault key and signing keys are its own, in its
   own cloud account or project; no service is shared with another installation
   ([runtime §5](security-runtime.md#5-isolation)).
6. **Secrets are write-only.** A secret goes in as a value and no API reads it back
   ([runtime §6](security-runtime.md#6-secrets)).

## What it does not promise

- **It does not check your business logic.** A handler that passes every check and then returns more than it should
  to an allowed caller, inside that caller's scope, is the application's bug. The platform bounds who may call and
  which rows the data layer reaches; it cannot know what a correct answer is.
- **It is not a sandbox against hostile code in an application.** The data-layer guard and the egress guard run in
  the application's own process, so code that takes that process over (a malicious dependency, a remote code
  execution) acts with everything the application holds
  ([runtime: what an application environment holds](security-runtime.md#what-an-application-environment-holds)).
- **On Cloudflare a deploy is only as trustworthy as the repository.** Repository code runs at deploy beside the
  account-wide API token, so a hostile commit there can reach the whole Cloudflare account, beyond the one application
  ([backlog 86](../backlog/86-a-cloudflare-deploy-holds-the-account-token-beside-the-repositorys-code.md)). On Zerops
  the build gets no application secret and no platform credential: the build container reads the service's variables
  as empty, and the generated build lifts only the source-map upload key
  ([`zerops-platform.md`](zerops-platform.md), [`packages/provider-zerops/CLAUDE.md`](../../packages/provider-zerops/CLAUDE.md)).
- **On Zerops, applications that share a deployment namespace are not isolated from each other.** Code in any service
  can make Zerops hand it the variables of every other service in the same Zerops project, whatever `envIsolation`
  says (measured, [`zerops-platform.md`](zerops-platform.md)). In a `cheap` namespace that is the shared PostgreSQL
  superuser and with it every application's schema; in `cheap` and `mid` also the namespace proxy's secrets for every
  application and each application's own credentials. Only a `full` namespace, a Zerops project of its own, keeps one
  application's code from another's data
  ([backlog 198](../backlog/198-an-in-container-env-write-may-reach-another-services-credentials.md)).
- **It runs no review of the code itself.** Approval judges the access a commit declares, not whether the commit was
  reviewed; Control reads no pull request review or CI status
  ([deployment: what is not a gate](security-deployment.md#what-is-not-a-gate)).

## What can go wrong

Each row: what the platform prevents by design, what it only limits, and what stays with the organization.

| Scenario                                                  | Prevented by design                                                                                                                                                                                                                                                                                 | Limited, not prevented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Stays with the organization                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A developer writes an endpoint with the wrong permission  | An endpoint without a declared requirement does not exist; the proxy and the application both check it ([runtime §2](security-runtime.md#2-the-endpoint-contract-checked-at-the-proxy))                                                                                                             | A requirement that is declared but too broad is the developer's choice; a new public procedure or off-road reach waits for approval in production, a plain widening (a role gains an action) does not ([deployment](security-deployment.md#who-approves))                                                                                                                                                                                                                                                                                                                                                                                                                      | Review who may call what; the approval screen and the access map per role show it                                                                                                                                                                                                                                                     |
| A developer exposes another department's data             | A query the data layer cannot scope is refused ([`guard.ts`](../../packages/db/src/guard.ts))                                                                                                                                                                                                       | A declared raw-SQL site decides its own scope; a later edit of its statement publishes without approval ([backlog 239](../backlog/239-a-changed-sql-statement-shows-no-closer-review-line.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Review raw SQL sites; the data layer is a guard against mistakes, not hostile code                                                                                                                                                                                                                                                    |
| An employee's session is stolen                           | The session cookie never leaves IAM's host; an application never sees it ([runtime §3](security-runtime.md#3-identity-lives-in-iam-the-application-never-sees-a-persons-credential))                                                                                                                | The thief acts as that person, with their permissions, until the session is revoked or, for an OIDC login, reaches the installation's cap; after revocation a cached token lasts at most 300 s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Revoke the sessions ([below](#revoking-and-rotating)); an administrator enrols two-step sign-in ([TOTP](human-authentication.md#two-step-sign-in-for-administrators)); anyone else has a second factor only through an OIDC provider                                                                                                  |
| An employee leaves                                        | A disabled principal mints no token ([`tokens.ts`](../../packages/iam/src/tokens.ts))                                                                                                                                                                                                               | Up to 300 s for tokens already minted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Disable the person in IAM, not only at the identity provider: an OIDC login asks the provider again only after the installation's cap (`FABRIKA_IAM_OIDC_SESSION_HOURS`, 12 h by default), a password login lasts 30 days ([runtime §3](security-runtime.md#3-identity-lives-in-iam-the-application-never-sees-a-persons-credential)) |
| An API key leaks                                          | A service key carries only its principal's grants; at a contract application only exact actions ([`packages/iam/CLAUDE.md`](../../packages/iam/CLAUDE.md))                                                                                                                                          | A key at the console may hold a wildcard role (`deploy.*`, `admin`), and a key provisioned without an application holds its grants at every platform service. A key bound to a user carries that user's live permissions at its one application. It works until revoked, or until its expiry if it has one: IAM's `issueKey`, `apiKeys.provision` and a key an agent asked for through an approval request are capped at 30 days; a key provisioned before that cap, or with the provisioning key, may have none                                                                                                                                                               | Grant keys the narrowest role; revoke or rotate a leaked one ([below](#revoking-and-rotating))                                                                                                                                                                                                                                        |
| A dependency of one application is malicious or exploited | It gets no person's password or session cookie ([runtime §3](security-runtime.md#what-an-application-environment-holds))                                                                                                                                                                            | It acts as the application: its data, secrets and machine keys, including connector keys to the procedures other applications export to it. It sees each caller's 5-minute token, and with it may issue share links the caller could issue. On Zerops it also obtains every variable of every service in its Zerops project, by writing a reference into its own service's variables and restarting its container (measured, [backlog 198](../backlog/198-an-in-container-env-write-may-reach-another-services-credentials.md)): in a `cheap` or `mid` deployment namespace that includes the other applications' credentials and, in `cheap`, the shared database's superuser | Keep dependencies few and current; rotate the application's secrets after an incident                                                                                                                                                                                                                                                 |
| An application sends data out                             | A handler's request starts only at an origin its contract declares, and so does every redirect it follows; a new origin waits for approval in production ([runtime §5](security-runtime.md#5-isolation))                                                                                            | The guard is in-process, not a firewall                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Review declared egress origins as you would a data processor                                                                                                                                                                                                                                                                          |
| A malicious commit reaches the repository                 | A protected environment publishes an off-road access change only after a person approves it ([deployment](security-deployment.md#who-approves))                                                                                                                                                     | A paved-road change, a change of a declared SQL statement and any business logic deploy on push. On Cloudflare the deploy runs that code beside the account token                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Branch protection and review on GitHub, which fabrika does not check; who may push the trigger branch                                                                                                                                                                                                                                 |
| A deploy key or a deployer's account is compromised       | A key cannot approve an access change, or deploy a protected environment by hand without a person approving it; no key, a person's own included, changes its trigger ref, domain, public origin or its app's source and build ([`approval/human.ts`](../../packages/control/src/approval/human.ts)) | A deployer's own account in the console is a person: with `deploy.trigger` it deploys any branch, tag or commit, to a protected environment too; only an off-road access change still waits for approval. A key bound to a user is not a person there either                                                                                                                                                                                                                                                                                                                                                                                                                   | Grant `deploy.*` narrowly; keep `prod` protected and `access.approve` with few people                                                                                                                                                                                                                                                 |
| An administrator's account is compromised                 | —                                                                                                                                                                                                                                                                                                   | An administrator holds every console action: secrets, approvals, protection. IAM records each of its own changes in that change's transaction and every administrator request before it runs; Control's changes reach IAM's audit best-effort and can be lost ([runtime §4](security-runtime.md#4-audit))                                                                                                                                                                                                                                                                                                                                                                      | Few administrators; two-step sign-in for each of them, or a second factor at the identity provider; export audit rows to storage you control                                                                                                                                                                                          |
| A migration destroys data                                 | A migration that may lose data runs only after a backup is stored, except in `dev` ([deployment](security-deployment.md#gates-in-order), gate 17)                                                                                                                                                   | Restore: on Cloudflare a side restore from the daily backups; on Zerops a manual restore in the Zerops GUI ([below](#backups-and-recovery))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Practise a restore                                                                                                                                                                                                                                                                                                                    |
| The cloud account or project is lost                      | —                                                                                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Everything: the installation's data, backups and keys live in that account. Keep the operator's secrets file and a copy of the database dumps outside it                                                                                                                                                                              |
| A vulnerability is found in fabrika                       | —                                                                                                                                                                                                                                                                                                   | A fix ships as a release tag ([`release-process.md`](release-process.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Upgrade the installation, the namespace proxies and each application's pin ([below](#keeping-it-current))                                                                                                                                                                                                                             |

## Operational security

### Keeping it current

- **The platform** moves when the operator runs `fabrika platform upgrade --to=<tag>` on Zerops, which commits the tag
  to the installation's own repository and deploys it. A namespace proxy stays on its pinned release until the operator
  moves it (`namespaces update --proxy-source=current`)
  ([`guide.md`](../../packages/provider-zerops/src/installation/guide.md)).
- **An application** keeps the `@fabrika/*` release it pins; a framework fix reaches it only when its pin is raised
  and it is deployed. A platform release keeps serving framework releases from the six months before it, and below
  that window refuses a new deploy but leaves the running version running
  ([ADR-0062](../decisions/0062-a-platform-release-serves-older-framework-releases.md)). Upgrading a fleet at once is
  not built ([backlog 266](../backlog/266-fleet-wide-framework-upgrades.md)).
- **No vulnerability policy or dependency scanning** is set up in this repository: it has no `SECURITY.md` and no
  dependency scanner in [`.github/`](../../.github/workflows/).

### Revoking and rotating

| What                                               | How                                                                                                                                      | Takes effect                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| A person's sessions                                | `sessions.revoke` / `sessions.revokeAll`, or disable the principal (console, Access)                                                     | At once; minted tokens last at most 300 s                                       |
| An API key, a share link                           | `apiKeys.revoke`, `apiKeys.rotate`, `shareLinks.revoke`                                                                                  | At once; minted tokens last at most 300 s                                       |
| An application's secret                            | `vault.rotate`                                                                                                                           | Next deploy; on Zerops written to the service at once                           |
| An application's signed-token key                  | `apps.environments.rotateTokenKey`                                                                                                       | Next deploy; the old key verifies until it ages out                             |
| Workload, connector, ops keys                      | Automatic at a deploy (workload keys past half of 30 days, ops keys at 15 days or at a deploy to another domain)                         | At that deploy; workload keys on Cloudflare also by maintenance, without one    |
| IAM's signing keys                                 | By hand: add a key to `FABRIKA_IAM_SIGNING_KEYS`, move it first, remove the old one later ([runbook](key-rotation.md#iams-signing-keys)) | A verifier caches the key set for up to 600 s                                   |
| An application environment's proxy secret          | By hand: delete Control's record of it and deploy ([runbook](key-rotation.md#the-proxy-secret-of-an-application-environment))            | That deploy; on Zerops the application refuses proxied requests while it builds |
| The vault key                                      | `rotate-vault-key` with Control stopped, on Zerops only ([runbook](key-rotation.md#the-vault-key-kek))                                   | When Control starts with the new key                                            |
| IAM's data key, IAM transport keys, GitHub App key | No command                                                                                                                               | —                                                                               |

The IAM verbs are in [`packages/iam/src/admin/rpc.ts`](../../packages/iam/src/admin/rpc.ts), Control's (`vault.rotate`,
`apps.environments.rotateTokenKey`) in [`control-rpc.ts`](../../packages/control/src/control-rpc.ts), the signing keys
in [`signing.ts`](../../packages/iam/src/signing.ts) and the JWKS cache in
[`verifier.ts`](../../packages/jwks/src/verifier.ts); the key lifetimes in
[runtime §3](security-runtime.md#what-an-application-environment-holds).

### Taking an application offline

`fabrika control apps environments suspend --app=<app> --env=<env>` takes an environment offline (the procedure
`apps.environments.suspend`, `app.manage` on the application, audited as `app.env.suspend`). `resume` undoes it
(`app.env.resume`) and restores exactly what was there before. Repeating either is a retry.

- **Zerops.** Control records the suspension and republishes the namespace proxy, whose entry for the environment then
  answers 503 to every request, on every path, before any credential is read and without dialling the application
  ([`deployment-namespaces.md`](deployment-namespaces.md)). The environment keeps its hosts, so no sibling can take
  them. The command returns once the proxy build has started; the 503 holds from the moment the new proxy version is
  live, a few minutes later (`fabrika control namespaces get --namespace=<id>` follows it). A namespace whose proxy is
  pinned to an older source (0.4.8, 0.5.5, 0.6.0, or any commit before the suspension marker) is refused with a 409
  naming the re-pin, `fabrika control namespaces update --namespace=<id> --proxy-source=current`, because its strict
  parser would refuse the manifest and the previous proxy would keep serving.
- **Cloudflare.** The environment's object goes into maintenance `closed` (refusing every ordinary request,
  [ADR-0069](../decisions/0069-control-reaches-an-application-environments-object.md)), and `resume` returns it to the
  mode it was in, `open` or `read-only`. `fabrika env maintenance <app> <env> closed` does the same without recording
  the mode to return to. An object already `closed` or in `inspect`, or one whose operation is still running, is
  refused. A maintenance transition or a recovery that opens the object ends the suspension in fact, while Control
  still shows it suspended until `resume`.

A suspended environment cannot move to another deployment namespace until it is resumed. A Control rolled back below
the release that added suspension ignores the record and republishes the environment as serving.

A suspension stops traffic through the platform's entry point; it does not stop the application's service, which keeps
running with its keys and can still call out. To stop the process too, or when Control is unreachable, the operator
stops the service in the Zerops GUI or the Worker in the Cloudflare dashboard. Deleting an environment in Control is no
takedown: on Zerops it is refused while the environment holds namespace resources, and where it succeeds it removes the
route but deletes no cloud resource and leaves its keys valid for up to 30 days
([`deployment-namespaces.md`](deployment-namespaces.md),
[backlog 203](../backlog/203-deleting-an-app-or-env-leaves-its-secrets-and-iam-keys.md)).

### Backups and recovery

- **Applications.** On Cloudflare each environment gets a daily backup into its own bucket, each one verified by a
  test import, and a side restore to a point in time
  ([ADR-0070](../decisions/0070-data-protection-of-an-application-environment-on-cloudflare.md)). On Zerops a backup
  is taken before a migration that may lose data, and otherwise Zerops' own daily database backups apply; a restore
  is manual in the Zerops GUI ([`zerops-platform.md`](zerops-platform.md)).
- **The platform's own databases.** On Zerops the platform deploy asks for hourly backups of the IAM and Control
  database (it replaces only an empty or once-a-day schedule, skips an older `light` installation without
  `operationsdb`, and a failure only warns), Operations' stays daily;
  restoring is download and `pg_restore`, and a single-node database (the default `light` tier) loses what was
  written since its last backup ([`guide.md`](../../packages/provider-zerops/src/installation/guide.md)). No
  recovery rehearsal of a whole installation is recorded
  ([backlog 05](../backlog/05-bring-up-on-a-real-zerops-account.md)).
- **Keys.** Losing the vault key loses every secret Control holds; it cannot be re-derived. On Zerops the operator's
  secrets file is the only other copy ([`installing-on-zerops.md`](installing-on-zerops.md)). Losing IAM's data key
  loses every enrolled authenticator, but nothing else: each administrator signs in with a recovery code or is reset,
  then enrols again. On an installation that got the key from a deploy rather than from `install`, no file holds it.
- **Retention.** A Cloudflare backup is offered for 30 days, but no bucket lifecycle rule deletes it afterwards
  ([backlog 237](../backlog/237-application-object-waves-4-7-follow-ups.md), item 1). Operations deletes no event it
  ingested: its database and every backup of it keep the index, and its object storage, which Zerops does not back
  up, keeps the raw event bodies
  ([backlog 199](../backlog/199-operations-keeps-every-event-forever.md)). IAM's retention is in
  [runtime §4](security-runtime.md#4-audit).

### Availability

On Zerops the default `light` tier runs one container per service and single-node databases: sign-in stops while any
of them is down. The `standard` tier runs highly available databases and two IAM and proxy containers
([`guide.md`](../../packages/provider-zerops/src/installation/guide.md)). Availability is otherwise the cloud
provider's; this repository states no SLA.

### Detection

Operations alerts on new and regressing errors, spikes and failed health checks, by webhook
([`operations-errors.md`](operations-errors.md)). A Zerops deploy that finds a public subdomain or a foreign bucket
fails and raises an alert ([`provider.ts`](../../packages/provider-zerops/src/provider.ts)). Sign-ins, refused sign-ins
and every administrator request are recorded ([runtime §4](security-runtime.md#4-audit)), but nothing alerts on them.

## Who controls what

- **Infrastructure.** The installation runs in the organization's own Cloudflare account or Zerops project, with
  credentials the operator holds ([`installing-on-zerops.md`](installing-on-zerops.md)). An installation calls no
  service run by fabrika's authors and sends no telemetry: it reaches the cloud provider's API, GitHub, the npm registry
  (at install and in every application build), ClamAV's signature mirrors when an application scans files, and what the
  organization configures (its identity provider, mail provider, alert webhooks, and the origins its applications
  declare).
- **Code.** fabrika is MIT-licensed ([`LICENSE`](../../LICENSE)), and every package's source, published or not, is in
  this public repository.
  Application source stays in the organization's GitHub repositories; the installation's configuration in its own
  sidecar repository.
- **Data.** Application data is in the installation's own databases (Postgres on Zerops, one SQLite per environment
  on Cloudflare; [runtime §5](security-runtime.md#5-isolation)), identity and audit in IAM's database, all in the same
  account. There is no export command of
  fabrika's own; on Zerops a database dump comes from Zerops, on Cloudflare from the environment's backups.
- **Lock-in.** An application is written against the `@fabrika/*` framework and needs IAM and the proxy at runtime;
  it is not portable to another platform without a rewrite of that layer
  ([`overview.md`](overview.md#why-it-exists-in-this-shape)). Control is not on the request path, so a running
  application keeps serving while Control is down.
