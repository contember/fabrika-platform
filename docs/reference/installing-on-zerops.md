# Installing fabrika on Zerops

How a Zerops installation is brought up and kept current, and why it is shaped this way.

**The operator's procedure ships with the CLI**, so an operator or an agent reads the one that matches
the release they run:

```bash
fabrika platform guide --provider=zerops
```

Its source is [`packages/provider-zerops/src/installation/guide.md`](../../packages/provider-zerops/src/installation/guide.md):
the six steps in order, what to ask the human for, how to hold each credential, and a check for every
step. `packages/cli/src/__tests__/guide.test.ts` fails when it names a command or a flag the CLI does
not have. The flags themselves are in each command's `--help`, and that text is authoritative.

The reasons behind the shape of this procedure are in
[ADR-0025](../decisions/0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) (the operator
owns the pipeline) and [ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)
(one `deploy` step owns the order).

## How install and deploy work

The internals behind steps 1, 3 and 6. The platform facts they rely on are in
[`zerops-platform.md`](zerops-platform.md).

### `fabrika platform install --provider=zerops`

The from-scratch bring-up: `packages/provider-zerops/src/installation/install.ts`. The operator either
creates an EMPTY project (core package `LIGHT`, `envIsolation: service` — a project-level setting
the platform accepts at creation only and never hands back, so nothing can verify it) and names it
with `--project-id`, or passes `--create-project` and this command creates it from the same compiled
declaration the services import comes from. A created project is polled to `ACTIVE` (`NEW` →
`CREATING` → `ACTIVE`, about 20 s live) before the first service import, because whether a service
import into a `CREATING` project succeeds has not been measured; its id is printed before the wait so
an interrupted run resumes with `--project-id`. The command is interactive and laptop-side,
confirming before every step that leaves the operator's disk, and it is the only command that
generates a credential for an installation. `platform admin` and `platform init` end with a pasteable
block for the first machine key: `export FABRIKA_IAM_RPC_URL=<IAM's PUBLIC origin>` (the value
`control` holds as `FABRIKA_IAM_ISSUER`), the NAMES of `FABRIKA_IAM_RPC_KEY` and
`FABRIKA_IAM_PROVISIONING_KEY` with the place each can be read from, and the `fabrika control key
issue` line — never a value. `http://iam:3000` answers only inside the project; `key issue` says so
when it cannot connect.

Its shape is decided by three [platform facts](zerops-platform.md):

- **Two passes, because the public hostnames come from a DEPLOY.** `zeropsSubdomain` names one host
  per deployed HTTP port and the proxy's ports come from its app version, not from the import — so
  pass 1 writes the legal empty manifest `{"apps":[]}` plus a syntactically valid IAM URL and key,
  builds the proxy alone, and reads the six lines back. Pass 2 writes everything else and hands the
  whole ordered sequence to `platform deploy`, which owns it (ADR-0027).
- **The import is skipped when the services already exist**, because re-applying a
  `startWithoutCode: true` document at a service carrying code activates an EMPTY app version and
  demotes the running one to `BACKUP`. A PARTIAL set is refused rather than completed: an import
  applies as one document and cannot skip the services that are already there. A service still reading
  `NEW` is refused too — see the [platform facts](zerops-platform.md).
- **Every process the import returns is waited on before anything is read or written**, because a
  service holds no environment at all until it leaves `NEW`.
- **Generated secrets are written blind and SENSITIVE.** Zerops answers `REDACTED` when one is read
  back outside sudo mode, so the command never compares one and cannot tell a correct value from a stale
  one — which is why it refuses a project that already carries those KEYS instead of writing over them.
  A second bring-up would roll a new vault KEK (unrecoverable) and new signing keys (every live token
  invalid). Every other variable is written readable, because `platform deploy` compares and merges it.

It places six generated values — IAM's ES256 signing keys, the IAM RPC key, the proxy key, the
provisioning key, the Operations sync key and the control vault KEK
(`packages/provider-zerops/src/installation/secrets.ts`) — plus one minted on the account: a Zerops
INTEGRATION token (`POST /client/{id}/integration-token`, client role `NO_ACCESS`, `ADMIN` on this
project only), so the installation never holds the personal token the operator authenticated with.
No value is printed. Before the first one is placed, all of them and the integration token are written to
`--secrets-file`, a new file outside the source checkout, mode `0600`, under the names `platform init`,
`platform admin`, `platform deploy` and `control key issue` read.

Fresh install always leaves GitHub source anonymous: it writes no App private key or webhook secret.
Public repositories therefore deploy without another setup step.

Mail is optional. Without `--email-provider` (or `FABRIKA_EMAIL_PROVIDER`) the installation has no mail transport. With one
(`--email-provider`, `--email-from`, optionally `--email-from-name`, and the provider's own variables from
the environment only), the command validates the set and writes it on `iam` and `control` alone, the
credentials sensitive and not in the secrets file: the operator already holds them. IAM sends its own mail
with it, and Control hands it to every application whose job declares `mailer: 'installation'`
([outbound email](outbound-email.md#the-installations-transport)). Nothing writes it again later; changing
it is the manual step in `platform guide` ([backlog 182](../backlog/182-set-or-rotate-the-installation-mail-transport.md)).

Both passes and the integration-token mint have run live on a fresh account
([archive](../archive/sprint-2026-08-07-zerops-from-scratch-install.md)).

### `fabrika platform deploy --provider=zerops --source-dir=.`

Both ordering rules in the [platform facts](zerops-platform.md), plus the manifest composition, live in code:
`packages/provider-zerops/src/installation/deploy.ts`. On Zerops the command owns the WHOLE ordered sequence —
prepare the committed source snapshot, resolve the project and its services, write each service's environment,
deploy IAM + Operations concurrently, then proxy and then Control, ensure the public entry point,
and reconcile the console's schema and IAM's own vocabulary — so an operator's pipeline calls one step. On Cloudflare the same command stays narrow and
the scaffolded workflow keeps the order. The asymmetry is deliberate
([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)); its full flag and
variable surface is the `usage` string in `packages/provider-zerops/src/installation/index.ts`.

Both `platform deploy` and `platform install` require `--source-dir` naming the clean full checkout
that contains the executing installation module. They refuse `--from-git` and
`FABRIKA_ZEROPS_BUILD_FROM_GIT`. The source is prepared once from a resolved commit before remote
mutations; all four setups are checked before writes. Each service reserves its own app version,
uploads that snapshot, builds the reserved version and polls its ID. No fallback selects a Git pipeline.
The first-install proxy pass and subsequent full pass share the same snapshot.

Install and deploy also derive Control's `FABRIKA_ZEROPS_PROXY_SOURCE_JSON` default from that snapshot's
commit and original descriptor, with the canonical public release repository coordinates. The JSON
environment representation escapes `$` as `\u0024` so Zerops does not interpolate references inside
the embedded descriptor; JSON decoding restores the exact bytes covered by its digest. Updating this
default does not modify existing namespace pins. An unpublished local commit cannot be fetched by
control's anonymous GitHub source; namespace source resolution must succeed before its provider mutations.

An ambiguous build response is observed without another submission or deletion; an unresolved wait
does not prove that the version failed. Namespace proxy sources are separately persisted and are not
pinned merely by selecting this installation checkout.

Three behaviours worth knowing before reading that file:

- **The manifest is the platform's own.** It names IAM, the console and Operations and nothing else: an
  application lives in a namespace with its own proxy
  ([ADR-0034](../decisions/0034-the-control-plane-creates-the-projects-it-owns.md)). It travels as the data file
  of the proxy's build archive
  ([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)). Releases up to 0.4.2
  wrote it into the proxy's `FABRIKA_PROXY_MANIFEST_JSON` as a sensitive variable; the deploy deletes that
  variable without reading it, because no token outside sudo mode can.
- **Hosts come from `zeropsSubdomain` unless the operator names them.** That variable is a NAME and not
  a state (see the [platform facts](zerops-platform.md)), so it can be read one step before `enableSubdomainAccess`. Naming all three hosts
  instead marks the installation `custom-domain`, and no subdomain is published.
- **Every variable is read and compared before it is written**, through `GET /service-stack/{id}/env`,
  so a re-run writes nothing. `putServiceEnv` itself stays write-first — it must also work on a service
  that has never been deployed.

Measured against the live `fabrika-test` on 2026-08-06 with `--dry-run` (reads only): of the
per-installation variables the command derives, only `ENVIRONMENT` on `operations`, `control` and
`proxy` and the proxy manifest differ from what was placed by hand. Every origin — `ISSUER`,
`FABRIKA_CONTROL_DOMAIN`, `OPERATIONS_ARTIFACT_ORIGIN`,
`FABRIKA_OPERATIONS_PUBLIC_HOST`, `FABRIKA_IAM_ISSUER`, `FABRIKA_ZEROPS_PROXY_IAM_URL` — reproduces the
live value byte for byte, and the composed manifest reproduces `vozka` and `operations` identically while
replacing `iam-local` with `iam`.

### The platform proxy manifest

**The platform installation's proxy manifest is generated in two halves.** The installation-independent
half — which apps exist, their ids, their private upstreams, the public listener each answers on and
their service tables — is declared in `packages/platform-artifacts/src/proxy-manifest.ts` and rendered into
the committed `packages/provider-zerops/src/installation/generated/platform-proxy-manifest.ts` by `bun run --filter
@fabrika/platform-artifacts gen`; CI's `gen:check` fails when it drifts from `controlServiceContract`,
`OPERATIONS_PUBLIC_SERVICE` or IAM's service table. A table entry is resolved into an installation entry (ADR-0022 "Installation
entries") with `serviceProxyTable`. The hosts and the browser-facing scheme belong to one installation and are
bound at deploy time by `resolvePlatformProxyManifest` (`packages/provider-zerops/src/installation/proxy-manifest.ts`).
`localPlatformProxyManifest` (`@fabrika/local-stack`) is a CALLER of the same generator with the local
hosts, so the two compositions can no longer disagree; `compileNamespaceProxyManifest`
(`republishProxy` in `packages/provider-zerops/src/namespace/proxy-attempt.ts`) remains separate — it builds an APP namespace's manifest
from the control registry.

IAM's app id on a deployed installation is `iam`. The live document said `iam-local` until this
generator replaced it, inherited from the local composition it was copied from at bring-up; the id is
inert because every row of IAM's table is a `protocol` or `health` row, for which the proxy mints no
token, so correcting it costs nothing.

## Where each credential lives

| Credential                        | Held by                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| Zerops personal access token      | The operator only. Used by `install`, stored nowhere.                            |
| Zerops integration token          | The secrets file, the `control` service, and the sidecar GitHub Environment.     |
| Provisioning key                  | The secrets file, the `iam` and `control` services, and the sidecar Environment. |
| Signing keys, vault key, RPC keys | The secrets file, and the services that use them.                                |
| GitHub App id and private key     | Control's vault, next to the connection's webhook secret.                        |
| Machine keys                      | Whoever they were issued to. `key issue` prints each one once.                   |

The services hold their copies as sensitive variables, which Zerops hands back only in sudo mode, so the
secrets file is the operator's only readable copy. The vault key cannot be recovered or re-rolled: losing
both the file and the Zerops project loses every secret the control plane holds.
