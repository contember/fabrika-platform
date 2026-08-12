---
id: 0029
title: An operator-owned GitHub App delivers Zerops application sources
status: accepted
date: 2026-08-11
---

# 0029 — An operator-owned GitHub App delivers Zerops application sources

## Context

[ADR-0025](0025-the-operator-installs-the-platform-fabrika-deploys-apps.md) chose Zerops' native
repository integration for private applications. It assumed an operator could authorize GitHub once
in the Zerops GUI and the installation's project-scoped integration token could then connect each
application service to an authorized repository.

The real account disproved that assumption on 2026-08-11. The Zerops GUI completed its GitHub OAuth
flow and listed `contember/fabrika-example-zerops`. A disposable service was then created in
`fabrika-install-test`, and `SetupExternalRepositoryIntegration` was called with the exact integration
token installed on the `control` service. Zerops returned `400 githubAuthorizationRequired`. Reading
the service afterwards returned `noExternalRepositoryIntegration`, so the failed call left no partial
configuration; the disposable service was deleted.

The OAuth grant is therefore usable in an interactive Zerops user context but is not a project
capability inherited by an integration token. Fabrika could ask an operator to connect every service
in the GUI, but then application registration would stop at an empty service and require a manual,
service-specific step. A personal Zerops token would merely move the problem into a long-lived human
credential held by the control plane.

Zerops has a second source path that does not depend on its GitHub identity. The path used by
`zops push` creates an application version, streams a repository archive to the returned upload URL,
then calls `build-and-deploy` with the repository's `zerops.yaml` and selected setup. Zerops still owns
the build container, executes the application build, deploys the result, and reports the process.

GitHub Apps provide the missing machine identity. An installation token is short-lived, can be
limited to selected repositories and read-only Contents access, and is not tied to a human account.
The remaining choice is where that identity lives and which component transports the source.

## Decision

We amend ADR-0025's private-source mechanism and ADR-0003's statement that the Zerops control plane
needs no filesystem helper. Their ownership boundaries remain: **the operator installs the platform,
Fabrika deploys applications, and Zerops executes every application build and deploy.**

Each Zerops installation has one internal `source` service alongside `control`. Public repositories
work anonymously. To deploy a private repository, the operator creates an organization-owned GitHub
App, installs it on the repositories that installation may deploy, and configures its App identity and
private key once for the Fabrika installation. There is no central Fabrika-owned GitHub App and no
shared credential across operators.

`fabrika app build` also embeds the bounded repository-root `zerops.yaml` and its SHA-256 digest in the
provider artifact. That artifact already describes the resources and selected setup used at
registration. Including the build descriptor lets `control` satisfy Zerops' required
`build-and-deploy.zeropsYaml` field without asking `source` to return repository content. A deploy
continues only when the descriptor at the resolved commit has the same digest, so a stale registration
cannot silently build with a different descriptor.

For each application deploy:

1. Before Operations release projection, `control` asks `source` to resolve the requested ref. For a
   private repository `source` mints a short-lived token for the recorded GitHub App installation; a
   public repository may be fetched anonymously. It returns the exact commit and descriptor digest.
2. `control` compares that digest with the registered artifact, persists the exact commit on the run,
   and creates the matching Operations release context and managed environment.
3. `control` creates the target Zerops application version with its existing project-scoped token,
   immediately persists that version id as the run's external operation, and receives its presigned
   upload URL.
4. `control` sends an authenticated upload request bound to the repository, exact commit, GitHub App
   installation, descriptor digest, upload URL, application version, and run correlation.
5. `source` reads that commit through Git objects, rechecks the descriptor digest, validates the tree,
   creates the repository-root archive without checking files out, and streams it to the presigned
   upload URL. It receives no Zerops access token and returns no repository content.
6. `control` asks Zerops to build and deploy the uploaded version with the descriptor from the provider
   artifact and the selected setup. The existing provider lifecycle follows the process and application
   version, relays logs, and records the same commit as the release source.

Public and private application repositories use this one artifact-upload path. The public
`buildFromGit` application path added as an intermediate checkpoint has been removed. Public
`buildFromGit` remains valid for Fabrika-owned installation artifacts such as the namespace proxy;
those repositories carry no application credential.

The GitHub App private key is an installation secret held by Zerops on the `source` service. Fabrika
stores only the App and installation identifiers needed to select the credential, consistent with
[ADR-0004](0004-secrets-live-in-the-platform.md).

**Invariants:**

- No GitHub token, private key, or credential-bearing URL is sent to Zerops application-version state,
  persisted in Fabrika's database, or written to an event or build log.
- The Zerops integration token never leaves `control`. The presigned upload URL is bound to one app
  version, treated as a credential in transit, never persisted by Fabrika, and never logged.
- `source` accepts only the live-verified Zerops upload destination: HTTPS on
  `proxy.app-prg1.zerops.io`, path `/api/rest/object-storage/upload`, empty username and password, no
  port or fragment, and a non-empty signed query. It refuses redirects and any cross-origin destination
  before reading repository bytes. An authenticated request binds the repository, ref, GitHub App
  installation, app version, upload URL, and Fabrika run.
- `source` never executes application code. It only resolves, fetches, packages, and uploads bytes;
  Zerops remains the application build and deploy executor.
- `source` packages directly from Git objects. It never checks out or extracts the repository, never
  dereferences symlinks, and rejects symlinks, submodules, special entries, non-contained paths, and
  trees above hard entry-count or expanded-byte limits. Local files and service secrets therefore
  cannot enter the archive.
- `source` has no public route. Its private RPC authenticates `control`; project-network reachability
  alone is not authorization because application services may share that network.
- A source job is bound to one repository, exact commit, app version, upload URL, and Fabrika run. The
  service returns only the resolved commit, descriptor digest and upload outcome; it never returns
  repository content.
- Neither `control` nor `source` may deploy the platform installation or the `source` service itself.
  Installation updates remain owned by the operator's sidecar or one-click flow.
- The run persists a credential-free provider checkpoint atomically with each external id. Zerops uses
  `version_created → source_uploaded → build_trigger_requested → build_triggered`. Each transition is
  committed before the next irreversible call except the result transitions, which are committed only
  after their call succeeds.
- Recovery never guesses across a lost response. `version_created` is deleted and failed even when the
  upload may have completed. `source_uploaded` advances to `build_trigger_requested` before calling
  Zerops. A recovered `build_trigger_requested` observes the app version: a build/deploy state is
  reconciled, while a version still `UPLOADING` after a bounded consistency delay is deleted and failed,
  never triggered a second time. `build_triggered` follows the recorded process and app version.

## Implementation record (2026-08-12)

The source contract and persisted run state (`d091d67`), isolated GitHub App credential client
(`49f3b17`), provider upload lifecycle (`4084234`), control delegation and webhook verification
(`4ab9ec2`, `5bc1f0e`), installation topology (`68854f3`), private source runtime (`71e406a`) and
canonical archive order (`b55d059`) implement this decision. Commit `5c9d99f` migrates active legacy
Zerops runs whose external app-version id predates provider checkpoints to the historically exact
`build_triggered` phase and isolates per-run reconciliation failures. The application provider no
longer has a `buildFromGit` branch: resolve, application-version creation, upload and
`build-and-deploy` are now the one application lifecycle. This is a local implementation witness, not
the live public/private acceptance gate recorded by the active sprint.

The production source runtime is fixed to `github.com` and `api.github.com`. It has no operator-facing
GitHub Enterprise or API-base setting; dependency-injected origins exist only as test seams. Before it
fetches Git objects, it resolves the commit and recursively reads the tree through GitHub REST. GitHub's
[recursive tree endpoint](https://docs.github.com/en/rest/git/trees#get-a-tree) limits a response to
100,000 entries or 7 MB. Fabrika is deliberately stricter on repository shape: at most 50,000 entries
and 512 MiB of declared expanded blob bytes, with a bounded 8 MiB REST response and an explicit refusal
of GitHub's `truncated` result. The fetched Git objects are then checked against that approved metadata,
the exact commit and the registered descriptor digest before any upload.

Every control→source call has an outer deadline: 45 seconds for installation lookup, five minutes for
resolve, 20 minutes for upload and 30 seconds for cancellation. The source service expires the first
three operations sooner—30 seconds, four minutes and 15 minutes respectively—so it can return a
redacted protocol result before control's deadline. The upload PUT itself is bounded to ten minutes.

Fresh `platform install` provisions private `source`, creates one RPC key under
`FABRIKA_SOURCE_RPC_KEY` on source and `FABRIKA_ZEROPS_SOURCE_RPC_KEY` on control, and deploys
`iam → operations → source → proxy → control`. GitHub App id and private key are optional but
all-or-none and are written only to source; the independently optional webhook secret is written only
to control. An anonymous public installation therefore needs no GitHub App configuration. For an
existing installation, interactive `platform init` offers a supported upgrade: it imports only a
missing source service with `startWithoutCode: true`, waits for the exact returned processes, and
writes source configuration directly to Zerops. Matching RPC keys are reused; if exactly one side has
a valid key, the absent side is repaired; if neither has one, one key is generated; invalid or
different values are refused. Omitted optional credentials preserve their live values. No source
credential is copied to disk, the sidecar repository or its GitHub Environment.

## Consequences

- A private application needs one GitHub App installation per operator scope, not one Zerops GUI click
  per application service. Removing a repository from the App immediately removes future deploy access.
- The Zerops installation gains one provider-specific service and one authenticated internal protocol.
  Source download, archive size, disk use, upload timeout, cancellation, and crash recovery become
  explicit operational concerns.
- The validated upload hostname is region-specific evidence. Supporting another Zerops region requires
  measuring its returned upload URL and adding that exact destination deliberately; a wildcard Zerops
  hostname is not sufficient.
- A failed fetch or upload leaves an app version that must be cancelled or deleted by `control`; the
  source service has no Zerops authority with which to clean it up itself.
- Live probes established that Zerops reports `UPLOADING` both before and after a successful archive
  PUT, so its app-version status cannot replace the `source_uploaded` checkpoint. `deleteAppVersion`
  returned success and removed versions in both states; this is the cleanup operation for every
  pre-trigger failure and ambiguous crash.
- The App private key has a smaller blast radius than a personal token but is still a high-value
  installation secret. The source service must mint tokens only for registered installation ids and
  must redact every upstream error before it reaches a run log.
- Ref resolution becomes deterministic. The archive and Fabrika release identify the same commit even
  when the requested input was a branch or tag.
- Changing the repository-root descriptor requires rebuilding and registering the provider artifact.
  A digest mismatch fails before a Zerops app version or Operations release is created.
- Zerops' native GitHub webhook and repository status UI no longer describe Fabrika application
  deploys. Fabrika owns deploy triggers; Zerops owns the build and deploy processes after upload.
- ADR-0003 still forbids a Zerops build runner. The new service is a source transporter, not an
  execution environment: it does not install dependencies or run application-defined commands.

## Alternatives considered

### Connect every service in the Zerops GUI

This uses the existing OAuth grant and keeps credentials entirely inside Zerops. Rejected as the
product path because registration would provision only an empty service and require a manual step for
every application environment. It remains an acceptable operational escape hatch.

### Store a Zerops user token in the control plane

A user token associated with the OAuth grant might be able to configure repository integrations.
Rejected because it is a long-lived human credential with broader authority than the project-scoped
integration token. The live probe also established no supported delegation from that grant to the
installation identity.

### Put a GitHub App token in `buildFromGit`

GitHub documents credentialed HTTPS clone URLs, but Zerops records the source URL on the application
version. Rejected because an expiring credential would cross the trust boundary and could survive in
platform state or diagnostics.

### Deploy from GitHub Actions with `zops push`

This is supported and substantially smaller. Rejected as the primary path because the repository
workflow would become the deploy authority, each repository would need a Zerops credential, and the
control-plane run would no longer own the complete lifecycle. It remains a useful CI escape hatch.

### Run one central Fabrika source service

A central service could hold one Fabrika-owned GitHub App and serve every installation. Rejected
because it turns a self-hosted installation into a dependency on a shared credential and service, and
widens one compromise across operators. An operator-owned App keeps the trust and failure boundary at
one installation.
