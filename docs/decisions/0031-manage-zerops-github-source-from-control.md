---
id: 0031
title: Manage the Zerops GitHub source connection from control
status: accepted
date: 2026-08-13
---

# 0031 — Manage the Zerops GitHub source connection from control

## Context

[ADR-0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md) assigns private repository
access to an organization-owned GitHub App and a private Zerops `source` service. [ADR-0030](0030-persist-github-app-creation-before-success.md)
made the original CLI manifest flow crash-resumable, but it still makes local installation the normal
place to connect GitHub. That is the wrong product boundary. An authenticated Fabrika administrator
expects to connect source from the running control plane, and GitHub's one-time manifest credentials
must become durable without passing through a worktree or a personal access token.

This ADR supersedes ADR-0030 only for normal Zerops GitHub setup. ADR-0030 remains the durability
record for the shared loopback helper and for legacy repair paths that still use it.

## Decision

Fresh Zerops installation starts in anonymous source mode. The authenticated control-plane UI is the
primary GitHub App setup path. `platform init` may inspect and repair the same remote state, but it is
not a second normal App-creation authority. Fabrika never asks for a GitHub personal access token.

Control exposes a provider-neutral source-connection API. The statically composed Zerops provider
implements its GitHub operations. The browser-safe API reports only phases, identifiers, verified App
identity and verified installation scope. It never returns a private key, webhook secret, source RPC
key or GitHub token. Every persisted state field and every log or error is redacted by construction;
none may carry GitHub's conversion response, manifest code, opaque state or credential values. The
global authorization action is `source.connection.manage`; it belongs to the future control policy
implementation, not to the portable DTO contract.

An authenticated start operation records a bounded, expiring, one-use setup state before returning a
same-origin continuation path. The state binds the administrator, installation, exact control origin,
requested organization, repositories and visibility. The callback route is network-reachable, but the
browser that follows GitHub's redirect must still hold an authenticated session for the same principal and
that principal must still hold `source.connection.manage`. The callback accepts only the exact path and
method, validates the opaque state, consumes it once with compare-and-set semantics, bounds its query
and GitHub conversion response, and enforces an overall deadline. The shared
`@fabrika/github-app` package owns the pure least-authority manifest builder and the bounded conversion
exchange. The manifest grants only repository contents read and the `push` event, uses fixed
`github.com`, and has no GitHub Enterprise or PAT option.

Control generates a new webhook secret. It stores that secret permanently in an encrypted
control-owned vault and resolves it dynamically for every webhook verification, so activation needs no
control restart. The setup row stores only nonsecret phase, hashes, App identity and remote references.

The App id and private key cross the source boundary as one versioned canonical JSON bundle. Its exact
bytes are bounded and SHA-256 bound. Control writes the bundle to one create-only source environment
variable and proves the durable value through an exact readback where Zerops exposes it. It then calls
an authenticated private source activation RPC with the same canonical bundle, digest and connection
binding. Source validates and imports the key before atomically replacing its in-memory anonymous
client. The response and status RPC expose only the credential version and digest plus the strict
verified organization-owned App identity. They never echo credential bytes.

The encrypted recovery copy lives in a platform-scoped vault entry encrypted under the installation's
KEK; it is never represented as an app or app-environment secret. It remains until control has durably stored and reread the source bundle,
activated source with a digest-bound response, stored the webhook secret, and verified the App
identity and webhook structure. GitHub masks the webhook secret, so readback can prove only the exact
URL, JSON content type and TLS setting after the successful secret-setting request. Recovery is then
deleted before the UI asks the administrator to install the App. The human installation grant is
verified with App-JWT GitHub endpoints for the requested organization and repositories before the
connection becomes active.

The first Zerops implementation must keep `source` at one active container while credentials are held
only in process memory. A future multi-container source service needs a broadcast or shared dynamic
configuration mechanism before it may report activation complete.

## Consequences

- Normal setup happens where the connection is used and audited. The CLI remains a narrow repair tool.
- The source private key is one atomic durable value. Partial App-id/private-key writes are no longer a
  valid steady state.
- Webhook verification observes rotations immediately through the encrypted control vault.
- Setup needs durable control state, an installation-scoped encrypted vault entry, a provider
  collaborator and authenticated source credential RPCs. Those runtime and database changes follow
  this shared-contract change.
- There is still an unavoidable orphan window after GitHub accepts manifest conversion and before the
  callback can persist its response. The administrator must delete and recreate such an App.
- Exact secret readback depends on live Zerops API behavior. If the API masks the source bundle, the
  implementation must fail closed or use a separately verified durable platform primitive; it must not
  claim exact readback from masked data.
- The complete browser, GitHub and Zerops flow remains a live-only gate.

## Alternatives considered

- **Keep local `platform init` as the normal setup UI.** Rejected: it requires local one-time-secret
  recovery and makes an installation command the ongoing connection authority.
- **Use a personal access token or the user's Zerops GitHub OAuth grant.** Rejected: Zerops cannot
  delegate that grant to Fabrika, and a PAT creates broader personal authority than the App needs.
- **Store App id and private key as separate source variables.** Rejected: no atomic platform write can
  prevent a partial credential state.
- **Activate webhook verification through an environment variable and restart.** Rejected: restart is
  operationally fragile and leaves a window where the running control process cannot verify the new
  secret.
- **Store GitHub credentials in the setup row.** Rejected: nonsecret workflow state and encrypted
  credential custody are separate responsibilities.

## References

- [ADR-0029 — An operator-owned GitHub App delivers Zerops application sources](0029-an-operator-owned-github-app-delivers-zerops-sources.md)
- [ADR-0030 — Persist GitHub App creation before success](0030-persist-github-app-creation-before-success.md)
- [Zerops platform reference](../reference/zerops-platform.md)
