# Static provider bundles

fabrika has an open provider contract and two concrete provider packages. An
installation links exactly one concrete provider into its runtime composition
root. Shared code receives that provider explicitly.

## Package boundary

| Package                        | Owns                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fabrika/provider-contract`   | JSON value/envelope types, typed codecs, the `ControlProvider` contract, the shared `runSteps` helper, authoring contracts; `/installation` command contract. |
| `@fabrika/provider-cloudflare` | Oblaka-based app authoring, codecs, plan, collaborators, control adapter; `/runner` runner job and protocol; `/installation` account bootstrap and deploy.    |
| `@fabrika/provider-zerops`     | Zerops app authoring, manifest compiler, schema/API client, codecs, plan, control adapter; `/installation` topology, plan validation, ordered deploy.         |
| `@fabrika/control`             | Provider-neutral registry, persistence, queue semantics, leases, run status, secret resolution, and HTTP API.                                                 |
| `@fabrika/installation-init`   | The operator-side `platform init` mechanics both `/installation` subpaths share: prompts, `gh`, and the sidecar scaffold.                                     |
| `@fabrika/platform-artifacts`  | Private. Zerops installation codegen: the rendered `zerops.yaml`, import YAMLs, proxy manifest, and console schema.                                           |

`@fabrika/platform` is a separate boundary. It describes host-runtime
capabilities such as SQL, queues, blobs, locks, assets, and background work. A
composition root supplies both the runtime adapters and the provider bundle.

## Deploy steps

Each provider's `deploy()` builds its own ordered step list and runs it through
`runSteps` (`packages/provider-contract/src/steps.ts`). `runSteps` records step
status and logs, stops at the first failure, and observes cancellation between
steps. It does not interpret the target, the artifact, or a step's kind. There
is no shared plan type, no runtime session, and no engine package.

## Control contract

The control plane receives one `ControlProvider`. Every provider implements
`id` and `deploy` (start or execute one run). A provider may also implement:

- `normalizeRegistration` to validate and canonicalize its target and artifact;
  absent means control stores the registration as submitted;
- `resolveSource` to resolve a requested source revision before deployment;
- `source: { binding: 'connection' }` to accept a private-source binding — a `(connectionId,
  installationId)` pair — which Control then passes as `sourceBinding` to `resolveSource` and `deploy`;
- `cancel` for platform-owned work;
- `reconcile` for unfinished external operations;
- `secrets` for immediate writes to provider-managed secret storage.
- `namespaces` for provider-owned placement validation, resource claims,
  provisioning, reconciliation, proxy republishing, and operator planning;
- `declaredVariables` to name the variables an artifact declares.

The bound-source inputs and credential-free `ProviderSourceBinding` are declared
once in `@fabrika/provider-contract`. Control loads the exact connection and
installation coordinates from persistence; a bound operation refuses a missing
capability or mismatched coordinates rather than using an unbound fallback.

Every deploy receives a provider-neutral `managedEnvironment` map assembled by
control: `FABRIKA_RELEASE`, `FABRIKA_IAM_ISSUER`, `FABRIKA_IAM_APP_ID` (the IAM
application id `<app>@<env>` the proxy mints for), and the source-scoped
Operations keys (`FABRIKA_OPERATIONS_DSN`, `FABRIKA_APP_ID`,
`FABRIKA_ENVIRONMENT`, `FABRIKA_SERVICE_KEY`). `null` removes a previously
managed value. Providers merge these values at their native deployment seam and
reject app-authored collisions. The Cloudflare provider passes them through the
runner job. The Zerops provider writes `FABRIKA_RELEASE` into the execution
descriptor of the version it builds and every other key as a service variable
([ADR-0044](../decisions/0044-zerops-delivery-ownership-and-recovery.md)).

An optional `artifactUpload` contains the bounded, release-scoped Operations
source-map endpoint and bearer. The Cloudflare runner consumes it where the build
files exist. The Zerops provider hands it to the platform build, whose last command
uploads the SPA source maps; see
[operations errors](operations-errors.md#release-source-maps).

Shared lifecycle code calls these capabilities directly. It does not select from
a runtime registry and does not branch on `cloudflare` or `zerops`.

The namespace capability receives the provider-neutral
`ProviderDeploymentNamespace` coordinates and an opaque target envelope. Its
optional operator surface publishes provider-defined presets, produces a
mutation-free plan, and renders safe facts and instructions. The control plane
does not interpret provider preset ids or plan options. See
[`deployment-namespaces.md`](deployment-namespaces.md).

## Persistence boundary

Provider-owned data crosses the control boundary as:

```json
{
	"provider": "provider-id",
	"version": 1,
	"payload": {}
}
```

The registry stores the canonical target and artifact envelopes in
`app_envs.provider_target_json` and `app_envs.provider_artifact_json`. Runs store
the provider operation id in `runs.external_run_id`. Provider credentials do not
belong in these envelopes; each composition root supplies them only for live
operations.

Managed environment values and artifact-upload credentials are per-run inputs.
They are never persisted inside provider target or artifact envelopes.

Deployment namespaces have their own provider envelope in
`deployment_namespaces.provider_target_json`. `app_envs.namespace_id` assigns an
environment to a placement. Core stores provider resource keys in
`namespace_resource_claims`; the provider derives the keys, while shared
persistence owns their atomic and immutable assignment.

The selected provider rejects an envelope with a different provider id or an
unsupported codec version. A new provider can define a different payload without
adding provider-specific columns or fields to shared control code.

## Composition roots

The Cloudflare installation starts at `packages/control/src/index.ts`.
`platform-cf.ts` composes `@fabrika/provider-cloudflare` with native Worker
bindings and the separate runner service. `@fabrika/provider-cloudflare/runner`
owns `CloudflareRunnerJob` and the runner protocol, `@fabrika/runner-container`
executes the job, and `@fabrika/runner-cloudflare` hosts and relays the
container. Neither runner package owns provider plan semantics.

### Cloudflare source and runner admission

`createCloudflareControlProvider` requires three separate collaborators:

| Option                         | Contract                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `resolveSource(input)`         | Return the verified immutable `commitSha` through the neutral `ProviderSourceResolutionInput` / `ProviderSourceResolution` contract. |
| `prepareClone(source, signal)` | Return `CloudflareCloneSource`, containing only the ephemeral `repoUrl`. It cannot replace the selected ref.                         |

Custom compositions use `CloudflareCloneSource` for clone authorization. The
`resolveSource` option selects source identity; it does not return a clone URL.
`startRun`, cancellation and recovery retain their separate execution roles.

The GitHub composition resolves the requested ref, or a recorded commit, with one
`GET /commits/{ref}`; GitHub resolves branch-versus-tag names and peels annotated
tags.
A public repository is read with a repository-scoped token from the connection of the organization that
owns it, when that connection's installation covers the repository, and anonymously otherwise; private resolution
uses a repository-scoped read-only token minted from the app's bound GitHub
connection — its App key read from Control's vault (see
[GitHub source connections](#github-source-connections)). The clone URL handed to
the runner carries a second such token as `x-access-token`; a public clone URL
carries none.

Control persists the selected commit under its ownership fence before creating
the release context. The original requested ref remains in run history. Non-dry
`CloudflareRunnerJob.ref` must contain a complete lowercase 40-hex GitHub commit.
The runner fetches that object, detaches HEAD and compares the observed commit
before installing dependencies or running repository commands. It logs the
expected/actual commit witness. Git authorization stays in the Git child's
environment, outside argv, persisted Git configuration and repository children.
Runtime release and source-map upload scope use Control's frozen release for
that same commit. Missing or mismatched objects fail without a branch fallback.

There is no source-protocol handshake: the runner Worker and image are rolled
forward before Control (ADR-0048). Errors after submission retain recovery
semantics because work may already have started.

Dry mutable-ref previews retain branch/tag cloning and release-unavailable
semantics. A dry full-SHA preview uses exact checkout verification. Dry previews
do not upload source maps.

The contract decision is [ADR-0048](../decisions/0048-bind-cloudflare-delivery-to-the-recorded-commit.md).
The detached runner/image precedes Control in an operator-owned rollout; see
[`release-process.md`](release-process.md#deployment-boundary).

### Zerops composition

The Zerops installation starts at `packages/control/src/zerops/server.ts`.
`zerops/provider.ts` composes `@fabrika/provider-zerops` with the Zerops access
token, control's in-process GitHub source (`packages/control/src/github/source/`, App
keys from the vault), and the namespace inputs. Deploy execution stays in the
Bun process. Recorded app-version ids are reconciled through the provider
capability after restarts: polled when the build was requested, deleted when it
was not. Control then records the terminal run and projects its terminal release
state to Operations before releasing the run lease.

### Zerops source transport

No Zerops deploy uses `buildFromGit`: Zerops builds a revision-suffixed Git source from the default
branch ([platform facts](zerops-platform.md)). Public and private GitHub repositories share one
upload path, run in-process by control (`packages/control/src/github/source/`, ADR-0029): resolve the exact
commit and the registered root `zerops.yaml` digest; create and record an application version; stream
the repository tarball for that commit into the version's upload; call `build-and-deploy` with the
validated, canonically rendered descriptor and selected setup. Namespace proxies use the same path
with the commit pinned in the namespace
([ADR-0045](../decisions/0045-upload-immutable-platform-and-namespace-proxy-sources.md)).

The registered descriptor retains its original text and SHA-256. Validation accepts one mapping
document with uniquely named setups. Multiple setups require an explicit selector. The selected setup
and every setup it `extends` are checked for foreign service references, and only they are sent to
Zerops, so a sibling setup for another placement never reaches this app's service. Tags, anchors/aliases, merge or
duplicate keys, non-string keys, ambiguous plain scalars and unsupported raw Unicode are rejected;
quoted equivalents of ambiguous scalars remain supported. The same canonicalization runs on recovered
builds. See [ADR-0043](../decisions/0043-validate-and-render-one-zerops-descriptor-meaning.md).

The transport needs no `git` binary and no `run.prepareCommands`, which matters because package
installation on a Zerops runtime requires `sudo`. App ids and private keys of every GitHub connection
live in control's vault; a request that names no connection resolves no credential, and there is no
credential search.

Each connection has an independent webhook secret encrypted in Control's platform vault. Every
connection's App receives `/webhooks/github/:connectionId`; Control resolves that exact connection and
secret before reading and authenticating the bounded body, then requires the payload installation,
repository and registered application pair to match it. There is no generic `/webhooks/github` route
(it answers 404) and no fallback to another connection.

Production origins are fixed to `api.github.com` and `codeload.github.com`. There is no operator-facing
GitHub Enterprise or GitHub API-base setting; alternate origins are dependency-injected test seams only.
Resolve is one pass over the archive of the requested ref, uploaded nowhere: GitHub resolves the ref in
the tarball request, the pax global header names the commit, and the root `zerops.yaml` must hash to the
digest registered in the provider artifact. A ref that is already the exact commit, as a namespace proxy pin
is, resolves once per Control process. A run's access snapshot (ADR-0050) is a second pass over the archive of
the resolved commit, which keeps the files the snapshot may read in memory (at most 1 MiB each and 32 MiB
together); a file it did not keep is read alone through `/contents`.

GitHub answers an anonymous caller 60 REST requests an hour per IP address, and every tenant behind a
cloud's egress address shares that budget. The tarball endpoint does not count against it (measured
2026-10-15: `x-ratelimit-used` stayed `0` across tarball requests while `/commits` and `/contents` each
spent one), so a Zerops deploy of a public repository spends none of it. The platform tree check below
spends two, once per Control process and commit. A 403 or 429 that GitHub sends for its limit fails the
operation as `rate_limited`, with a message that names the reset time.

Archive and upload are one streamed operation. Control requests
[`/repos/{owner}/{repo}/tarball/{sha}`](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)
with `redirect: 'manual'`, requires the `Location` origin to be exactly `https://codeload.github.com`,
and fetches that URL without the installation Authorization header — the codeload URL carries its own
short-lived token in its query and is treated as a credential in transit. The response is piped
`gunzip → tar rewrite → gzip → PUT`, so no repository byte is staged on disk or buffered whole.

The application tar rewrite reads GitHub's `git archive` output 512 bytes at a time. It confirms the commit from
the pax global header's `comment`, strips the single archive prefix, keeps regular files only and
rewrites each header with mode `0755` or `0644`, uid and gid `0` and a fixed mtime. The tarball's own
directory entries are dropped; instead each parent directory is written once, outermost first, before
the first file beneath it, because the platform's unpacker creates no directory it was not told about
([platform facts](zerops-platform.md)). It rejects symlinks, hard links, devices, GNU long-name entries, every other special typeflag, a
root `.gitmodules`, paths outside the prefix or containing `.`/`..`, duplicate paths, a pax `linkpath`
record, a pax record over 64 KiB, and a truncated stream. It admits at most 50,000 files and 512 MiB of
file content, counted incrementally. It hashes the root `zerops.yaml` as it passes: a missing or
drifted descriptor fails the operation. Because the tarball is `git archive` output, `.gitattributes`
`export-ignore` and `export-subst` apply. Archives are not byte-deterministic across runs and nothing
depends on that.

A public archive may be uploaded as kind `platform`, which takes no credential. Before downloading it,
control checks the exact commit's Git tree, once per process: the commit and root tree identities must match, the tree
must explicitly be complete, and gitlinks are refused even without `.gitmodules`. Metadata is bounded
to 7 MiB and 50,000 entries; truncated or malformed trees fail before download or upload.

Platform mode preserves relative symbolic links after validating the full archive namespace. It
refuses escapes, cycles, dangling targets, path-type collisions, entries beneath symlinks in either
order, and symlink descriptors. Hard links and special entries remain refused. Contents stay streamed;
bounded path/link metadata supports the final verdict. A PUT response alone is not upload success:
the archive's validation verdict must succeed too. The `application` kind keeps the strict behaviour,
including rejection of symbolic links and PAX `linkpath` records.

**Public platform archive witness, 2026-10-02.** Exact commit
`9917992ad1a0a462e060064255d9a90a3a2ed968` passed live GitHub tree checks and streamed archive validation:
1,394 entries, 9,202,153 expanded file bytes, descriptor SHA-256
`12ea505cc6fe782871b350d5ac2e58d7bd1b2874ec7ee4da152b814f6a8c68b0`. Native tar inspection preserved
both `packages/auth-core/AGENTS.md` and `packages/installation-init/AGENTS.md` as relative links to
`CLAUDE.md`. The production-style gzip/native-fetch pipeline completed against a local HTTP sink.

For local stream witnesses on Bun 1.3.14, consume the archive through a reader and incremental
`FileSink`. `Bun.write(path, new Response(customStream))` stalled even for a network-free 2 KiB
stream; an upstream HTTP abort did not unblock that consumer after download had completed.
A native fetch consumer did not exhibit that failure. Bun's compression streams also ignore
backpressure, so the pipe pulls through explicitly (`packages/control/src/github/source/streams.ts`).

The transport accepts only the measured `prg1` upload destination: HTTPS host
`proxy.app-prg1.zerops.io`, exact path `/api/rest/object-storage/upload`, empty userinfo, no explicit
port or fragment, and a non-empty signed query. It refuses redirects. The credential-bearing upload URL
exists only in memory for the live PUT; it is never persisted or logged.

Resolve is bounded to four minutes and upload to 15 minutes; the PUT itself is bounded to ten minutes,
and that bound covers the whole download-rewrite-upload pipe
(`packages/control/src/github/source/transport.ts`). Caller cancellation is propagated through GitHub REST,
the tarball download, the rewrite and the upload.

Validation happens while the PUT is in flight, so a rejected repository aborts the upload. The
transport settles the archive verdict before it blames the network: the run sees `archive_rejected`,
`descriptor_missing`, `descriptor_mismatch` or `commit_mismatch` rather than `upload_failed`. Every
such failure is pre-trigger, and the provider deletes the app version on every pre-trigger failure.

The same example commit reached `ACTIVE` through application-version upload while the repository was
public and again after it became private. A later private push also completed the scoped webhook path
end to end: verified event, webhook-triggered run, private source resolve and upload, Zerops build,
active version and healthy app. The inspected application version used source `CLI` and carried no
GitHub, GitLab or public-Git source.

### GitHub source connections

GitHub App setup runs in the authenticated Control console at **Settings → Source**
([ADR-0029](../decisions/0029-github-app-sources.md)), the same way on Cloudflare and Zerops. Fresh
installations boot with anonymous source access; neither `platform init` creates an App. The page lists stable connections in bounded pages and presents the
one global setup or repair workflow separately. A human principal holding `source.connection.manage`
can add another private organization-owned App while stable rows remain. Only one nonterminal workflow
may exist, and the same organization cannot be connected twice, but Fabrika imposes no total
connection-count limit. Setup accepts an optional same-owner repository set. Control returns only a
same-origin continuation path; no private key, webhook secret, manifest code or opaque state enters a
browser DTO, URL log or error.

The continuation is a page that submits a least-authority manifest directly to `github.com` by itself;
its CSP admits only that page's nonce'd style and script, and form posts only to `https://github.com`.
The manifest names the App's setup URL, `/api/source/github/setup/:connectionId`, with redirect on
update. The callback requires the same authenticated human principal, exact Control origin and one-use
encrypted state. It rejects unknown or duplicate query fields, bounds the GitHub response and, once the
App is configured, redirects to the App's installation page on GitHub (to a clean `/settings/source`
URL when the setup needs repair). Before the browser can observe success, Control stores GitHub's one-time App id
and private key in its encrypted platform vault, in the same transaction as the setup checkpoint. The
setup state stores only nonsecret phases, hashes, verified identities and vault references.

For every new connection, Control then (`packages/control/src/github/connections/`):

1. verifies the organization-owned App identity, visibility, permissions and sole `push` event with the
   vault key. Contents and Pull requests may be read or write; any other permission except Metadata read
   refuses the App. The manifest asks for both as write, for MCP authoring
   ([ADR-0029](../decisions/0029-github-app-sources.md)); a deploy token is still minted with Contents read
   only;
2. creates a new webhook secret in the Control vault, configures the exact scoped HTTPS callback and
   verifies the returned URL, JSON content type and TLS setting;
3. verifies the organization or every requested repository through App-JWT endpoints before
   publishing the connection, when GitHub returns the installer to the setup URL.

The setup URL takes `installation_id` and `setup_action` as hints only. It needs a human principal with
`source.connection.manage`, verifies the installation with the App's vault key exactly as the console's
verify action does, refuses a query id that names another installation, and publishes only the
connection its path names. It lands on `/settings/source?github-setup=<outcome>`: `connected`,
`unverified` (nothing published) or `approval-requested` (`setup_action=request`: an organization
owner still has to approve; GitHub sends no id). The console shows that notice only when the
connection state it reads agrees with it. When the browser does not come back (another tab, an owner's
approval, an App created before the setup URL existed), the console shows two steps: open the
installation on GitHub, then verify it. It polls while the App waits for its installation.

GitHub masks the webhook secret, so the structural readback cannot compare that value. Control starts
using the new vault-backed secret after structural webhook verification, including while installation
is still pending.

A stable connection can be reconciled from the same page. Reconciliation re-verifies the App identity
with the vault key and reapplies the connection's exact stored webhook URL, content type, TLS setting
and secret. It never changes the App, webhook secret, connection id or application binding.

A private application is registered against the connection whose canonical organization owns its
repository. Control persists both the connection id and GitHub installation id or neither. Deploy
resolution and scoped webhooks require that exact pair. Changing the repository owner of an already
bound application is refused; re-registration is required. Public repositories need no pair.

Verified live on 2026-08-20: after a webhook repair, the next private repository push reached that
connection's scoped webhook route, passed HMAC verification and created run
`01a01f7c-037b-702e-8ec8-b3f186144b22` for exact commit
`0d608e0071119c85ac144f78c1ad1509f7a22ab7`. The run succeeded, Zerops version
`haveZKs7So2jjGl00vhxGQ` reached `ACTIVE`, and the deployed `/healthz` answered `200`.

`platform init` does not touch GitHub credentials: a private source is connected only through Control's
**Settings → Source**, and source credentials never enter the sidecar checkout, repository or GitHub
Environment. A `source` service left by an earlier layout is reported with one warning by
`platform deploy` and never deleted (`packages/provider-zerops/src/installation/deploy.ts`); it may
still hold App keys, so delete it by hand.

One unavoidable orphan window remains after GitHub accepts manifest conversion but before the callback
durably stores the response; such an App must be deleted and recreated. Multi-connection acceptance
evidence is recorded by the archived
[multi-connection sprint](../archive/sprint-2026-08-14-multiple-private-github-source-connections.md).
The single-connection public/private deployment gate is recorded by the archived
[application deploy sprint](../archive/sprint-2026-08-11-fabrika-deploys-an-app-on-zerops.md).

### Shared lifecycle ownership

`@fabrika/platform` supplies the shared SQL lease implementation. Acquisition is non-reentrant;
release matches the holder. `renew(key, holder, ttlMs)` extends only a still-live lease owned by that
holder, using one conditional update. Control wraps it in one primitive (`packages/control/src/lease.ts`):
a 90 s TTL renewed every 30 s, with a local deadline one renew period before the stored expiry. Runs,
namespace jobs, terminal repair and the Operations catalog sync all use it. Failed renewal or a missed
local deadline aborts the lease's signal. Lease loss stops the invocation; it does not request external
cancellation. On SIGTERM the Zerops Control process takes no new catalog lease and, after a 10 s grace,
interrupts the catalog flush it still runs and releases that lease. The catalog's reconcile write is
holder-fenced like a run write, so an interrupted flush's late write cannot land over the next holder's.

Every run lifecycle write is holder-checked: `RunRepository` locks the run's `<app>:<env>` lease row
and writes only while that holder's lease is live, in the same database transaction. There is no
checkpoint compare-and-swap. A cancellation request changes no lifecycle state; the lease holder reads
it at its next step boundary.

An unresolved provider result keeps the run running after the invocation releases its lease. That row
blocks a later deployment until recovery establishes settlement. Cancellation similarly remains
requested until the provider returns `settled`; acknowledgement alone is insufficient. Cloudflare
runner recovery fences delayed startup before settling a never-dispatched run, while dispatched work
retains its detached completion backstop.

`packages/control/src/__tests__/entrypoint-isolation.test.ts` walks both import
graphs. It verifies that each root reaches only its selected provider and runtime,
while shared control modules reach neither concrete provider.

## Authoring and commands

Cloudflare apps import their config surface from
`@fabrika/provider-cloudflare`:

```ts
import { defineApp, Worker } from '@fabrika/provider-cloudflare'
```

Cloudflare app resources are composed as a public proxy Worker with a private
application Worker child (ADR-0048). The config's `resources` returns only the
application Worker; the deployer builds the proxy Worker `<app>-proxy` from this
package's own entrypoint and directory, never from the checkout, and refuses a
config Worker that binds `APP`. The proxy enforces the application's endpoint
table from the contract Control approved (outside Control, `fabrika.contract.ts`
in the checkout, read statically) and the deployer writes `FABRIKA_CONTRACT_DIGEST`
into the application Worker. A checkout without a contract, and a config that
declares `gates`, are refused. The checkout's Worker graph is rebuilt from the runner's own `Worker`
class, because the checkout installs its own `oblaka-iac`.

The checks read the wrangler configs oblaka generates, whatever object emitted
them: once from a dry generation run before provisioning, and again on the
configs oblaka wrote before the first `wrangler deploy`. An application config has
no routes and sets `workers_dev` and `preview_urls` to `false`; only the platform
proxy is routed, on the run's own domain. Config keys are an allowlist. No name a
config binds, and no name a resource adopts, may be a platform resource or a name
of another application of the installation — the deployment in Control's registry
whose `<env>-<app>` is the longest prefix of the remote name. A D1 or KV binding
must carry an id the generation run handed out. Every Worker in the graph, the
proxy included, binds IAM at its `PropustkaApplication` entrypoint
(`iamServiceReference()`); a binding to IAM's default entrypoint, which also issues
keys and approves devices, is refused. The provider preserves the generated Wrangler config for every
Worker in that graph, deploys each config, and targets application migrations,
managed variables, and secrets at the child Worker. The proxy embeds only its
manifest and service bindings; application secrets stay on the child.

The public command exposes:

```text
fabrika app deploy --env=<env> [--config=<path>] [--dry-run]
```

The provider is inferred from the provider-authored config. The
`fabrika-cloudflare-executor` binary is internal to the runner container; it is
not an operator surface.

Zerops apps import their config surface from `@fabrika/provider-zerops`:

```ts
import { defineApp } from '@fabrika/provider-zerops'
```

Its build command evaluates app-owned TypeScript before registration:

```text
fabrika app build --env=<env> [--config=<path>] [--output=<path>]
```

The resulting `fabrika.manifest.json` is the provider-owned artifact. The control
plane validates and stores it, then performs deployments without importing the
app's TypeScript.

The manifest boundary (`parseFabrikaManifest`, on build and on every decode)
refuses the import fields that would expose an application service past the
namespace proxy or change what it builds (ADR-0043): an `objectStoragePolicy`
other than `private`, any `objectStorageRawPolicy`, `buildFromGit`, `zeropsYaml`
or `mount`, and an `enableSubdomainAccess` or `enableCdn` other than `false`. An object-storage
service that omits its policy gets an explicit `private`. The
installation and the namespace proxy compile their own documents and keep these
fields.

`fabrika app register --env=<env> --app=<id> --repo=<url> [control register options]`
builds the same artifact in memory and immediately sends the create-only
`control register` request for it. It writes no file, and Control still never
runs application code.

The same public command exposes the provider-owned namespace operator:

```text
fabrika namespace plan --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace create --id=<id> --env=<env> --preset=<cheap|mid|full>
fabrika namespace adopt --id=<id> --env=<env> --preset=<cheap|mid|full> --project-id=<id>
fabrika namespace reconcile --id=<id>
```

`plan` runs without mutation. `create` and `adopt` submit the provider-generated
namespace envelope to the control API. `reconcile` resumes the stored,
checkpointed lifecycle.

## Installation commands

`@fabrika/cli` is the only public executable. Platform commands select an
`InstallationCli` from `@fabrika/provider-contract/installation`:

```text
fabrika platform init --provider=cloudflare <account> --console-host=<host> --operations-host=<host> --iam-host=<host> --auth-methods=<oidc|password|oidc,password> --email-provider=<none|resend|smartemailing> [--email-from=<address>] [--email-from-name=<name>] [--yes]
fabrika platform plan --provider=cloudflare (--runner-config=<path> --worker-config=<path> | --component-config=<path>)
fabrika platform deploy --provider=cloudflare (--runner-config=<path> --worker-config=<path> | --component-config=<path>)
fabrika platform init --provider=zerops <installation> --tag=<tag> --project-id=<id> [--repo=<owner>/<name>] [--checkout=<dir>] [--yes]
fabrika platform plan --provider=zerops
fabrika platform install --provider=zerops --client-id=<id> --env=<name> [--project-id=<id> | --create-project [--project-name=<name>]] [--email-provider=<none|resend|smartemailing> --email-from=<address> [--email-from-name=<name>]]
fabrika platform deploy --provider=zerops [options]
fabrika platform upgrade --provider=zerops --to=<tag> [<installation>] [--sidecar=<path>|<owner>/<name>]
```

Both providers support all three operations, and **how wide each one is, is the
provider's own answer** ([ADR-0027](../decisions/0027-platform-deploy-is-as-wide-as-the-provider-needs.md)).
Zerops' `plan` is mutation-free and validates the generated installation
artifacts. Its `deploy` owns the whole ordered sequence, while Cloudflare's
composes the runner/control pair and the scaffolded workflow keeps the order. Its
`init` creates and maintains the operator's sidecar repository for an installation
that already exists; on Zerops the first bring-up is `platform install`, which can
also create the project it installs into; it is two passes, because a proxy that
has never been deployed publishes no hostname for the manifest to carry.
`fabrika platform <command> --provider=<name> --help` prints the installation's own
surface. The CLI maps the official `cloudflare` and `zerops` ids to
`@fabrika/provider-<cloud>/installation` and treats any other provider value as an importable package
specifier.

For app commands, provider selection comes from the default-exported
provider-authored config. An explicit `--provider` is required only when no app
config is available.

The architectural constraints and rejected dynamic-registry alternative are in
[ADR-0011](../decisions/0011-static-provider-bundles.md).
