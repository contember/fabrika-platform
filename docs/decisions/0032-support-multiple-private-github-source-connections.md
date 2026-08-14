---
id: 0032
title: Support one private GitHub source connection per organization
status: accepted
date: 2026-08-14
---

# 0032 — Support one private GitHub source connection per organization

## Context

[ADR-0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md) gives each Zerops
installation a private `source` service and an operator-owned GitHub App. [ADR-0031](0031-manage-zerops-github-source-from-control.md)
makes the authenticated Control console the normal place to create, persist, activate and verify that
App. The first implementation deliberately models one connection for the whole Fabrika installation:
Control has a singleton connection row, source imports one canonical credential bundle and holds one
active GitHub client, the app registry records only a GitHub installation id, and all GitHub Apps send
to one generic webhook path.

A private GitHub App cannot be installed outside its owner account. An operator who deploys private
repositories from more than one GitHub organization must therefore either make an App public or run a
private App owned by each organization. Making the App public expands who may install it even when the
operator needs only a closed set of organizations. Fabrika must support the narrower authority without
creating a central App or moving credentials out of each installation's private source service.

The existing connection may already be live. Its v1 environment key, credential bundle, source RPC
and generic webhook URL are durable external state. An in-place reinterpretation would make a normal
rollout depend on simultaneous source, proxy and Control replacement. The multi-connection model must
therefore be additive and keep the existing path working while new connections use an unambiguous
identity at every boundary.

## Decision

One Zerops Fabrika installation may hold multiple GitHub source connections. Each new connection owns
one private GitHub App in exactly one GitHub organization and one verified installation of that App.
The case-insensitive organization login uniquely selects a connected private App within the Fabrika
installation. Adding a connection for an organization that already has one fails closed.

Fabrika imposes no explicit connection-count limit. Individual HTTP bodies, credential bundles,
repository lists, identifiers and database pages remain bounded. Control collection APIs are paginated
rather than placing all connections in one bounded request or response. Zerops or GitHub resource
limits may still reject an operation, but Fabrika does not translate them into a fixed product cap.

Control allows only one global nonterminal setup attempt at a time, including a repair-required
attempt. Connected rows do not block a new attempt. This keeps the manifest callback, one-time recovery
material and repair UI unambiguous while the stable connection set is plural.

### Credential identity and custody

The canonical source credential bundle v2 contains `version`, `connectionId`, `githubAppId` and
`privateKeyPem`. The `connectionId` is therefore covered by the same canonical-byte SHA-256 digest as
the App id and private key. Activation refuses a request whose outer connection id differs from the
embedded id.

The source protocol adds `/v2/source/credentials/activate`, `/v2/source/credentials/status`,
`/v2/source/resolve` and `/v2/source/upload`. Their bounded request and response types, path constants,
canonical bundle codec and public exports land as one compatibility seam. Source keeps serving the
frozen v1 credential, resolve and upload paths. A v1 decoder never accepts a v2 bundle or v2-only field,
and a v2 decoder never infers a missing connection coordinate.

Each v2 bundle is written once to its own Zerops source-service environment key. The key is a fixed v2
prefix plus the full lowercase hexadecimal SHA-256 digest of the canonical connection id. The hash is
an environment-key-safe locator, not an authorization secret. Control uses create-only writes and
exact rereads. It never updates a shared aggregate credential document.

Environment inspection must first be measured against the live Zerops API. If Zerops exposes a
targeted key lookup or pagination, Fabrika uses the verified behavior. Otherwise it reads the full
environment response through an explicit response-body byte bound and selects the exact derived key.
An aggregate entry-count rejection must not become an implicit connection-count cap.

At boot, source discovers each v2 slot, validates that the slot suffix matches the embedded connection
id, imports the private key and constructs an immutable client snapshot keyed by connection id. A bad
or conflicting slot fails startup; source never silently ignores malformed credential state. Dynamic
activation validates the new snapshot before atomically adding that key to the in-memory map. One
connection cannot replace another connection's client.

The existing base `GITHUB_APP_CREDENTIALS` v1 bundle and the older split App-id/private-key variables
remain the legacy credential source. They continue to produce the one legacy/default client and are
not rewritten into a v2 slot during this work. The existing connection may bind that client through
the current v1 status/activation behavior. New connections always use v2 bundles and keyed slots.

During the manifest callback, Control may carry the bounded plaintext key in memory while it validates
the conversion response, prepares encrypted recovery and sends the credential toward source. The only
private-key material Control may persist or durably hold is ADR-0031's KEK-encrypted recovery entry. It
deletes that entry after durable source configuration is verified and before setup waits for
installation verification. Plaintext never enters a response, log, database row or workflow
checkpoint. A final connected row holds only connection metadata, the credential digest and the
encrypted webhook-secret reference; the durable private key remains an installation secret held by
Zerops on `source`.

### Control persistence and registry binding

Control adds a keyed connection table instead of replacing or rewriting the existing singleton table.
Every keyed row has an immutable `transportKind` of `legacy-v1` or `keyed-v2`. The migration copies the
singleton row as the sole `legacy-v1` row and keeps the singleton as compatibility evidence. New
connections are always `keyed-v2`; no later update changes a row's transport kind. The keyed table
becomes the authority for multi-connection reads. New writes go only to the keyed table. The copy is
idempotent and preserves the legacy connection id, App identity, installation id, credential digest,
webhook binding and verification timestamps.

Every Zerops private application registration and operation binds the pair
`(github_connection_id, github_installation_id)`: the Zerops path accepts both values or neither. The
shared application table keeps `github_connection_id` nullable because a Cloudflare registration may
legitimately carry `github_installation_id` without a Zerops source connection. Migration backfills an
application only when its installation id matches the copied legacy connection and `app_envs` contains
an environment for that app with `provider = 'zerops'` and none with another provider. A mixed-provider
app is explicitly skipped; its next Zerops private-source operation fails the incomplete-binding check
instead of guessing. A repository owner selects one connected organization; onboarding does not probe
unrelated Apps. Control refuses a manual or webhook-triggered Zerops private-source operation when the
stored pair does not belong to the repository owner and connected App.

The provider-neutral app-source model can carry the connection id beside the installation id; Zerops
requires the pair for its private-source path, while Cloudflare may continue to carry only its GitHub
installation id. Control loads the referenced keyed connection row and selects source protocol from
its immutable transport kind, never from the presence of `connectionId`: `legacy-v1` uses the frozen v1
resolve/upload wire, while `keyed-v2` sends both coordinates on v2. Source selects the exact keyed
client before minting a repository token. The v1 resolve and upload endpoints can use only the
legacy/default client. They never search the v2 client map or guess from an installation id.

### Webhook routing

Each new Zerops App uses `/webhooks/github/:connectionId`. The proxy exposes that path as public
because the GitHub HMAC remains its authentication mechanism. Control resolves exactly that
connection's encrypted webhook secret before parsing the bounded body. It never tries every stored
secret.

After HMAC verification, Control requires the webhook payload's installation id to equal the
connection's verified installation id. A push can trigger only registry entries bound to that exact
connection-and-installation pair and repository. An unknown connection, an invalid signature, a
mismatched installation or a mismatched registry binding fails without trying another connection.

Webhook behavior is provider-composition-specific. In a Zerops composition, the existing
`/webhooks/github` route remains available only for the migrated `legacy-v1` connection. Its secret and
GitHub webhook configuration remain unchanged, and it can trigger only registry entries bound to that
legacy pair. New Zerops Apps never use the generic route. A Cloudflare composition preserves its
existing static webhook-secret verification and installation-id routing; it has no Zerops connection
row to migrate and this decision does not narrow its generic route.

### API, UI and compatibility

The source-connection admin API exposes a paginated stable connection list plus at most one global
nonterminal setup state. Start creates a private App connection for one organization. Verify and repair
remain keyed by connection id. The browser-safe projections continue to exclude private keys, webhook
secrets, source RPC keys, manifest capabilities and GitHub tokens.

The Control console lists connected organizations and their verified scope, shows the one pending or
repair-required workflow separately, and offers `Add connection` while stable connections exist. The
legacy connection may still report that its App was public, but this work does not create or route one
public App across organizations.

Rollout order is source, then proxy, then Control and dashboard. The new source serves both v1 and v2
before any v2 credential can be written. The proxy exposes both webhook routes before Control assigns
the scoped URL. Control begins keyed persistence and v2 traffic only after those seams exist. Rolling
source back after more than one credential has been persisted is unsupported: the old source does not
understand v2 slots or v2 requests, so affected private deploys fail closed rather than using the wrong
App.

**Invariants:**

- A new private connection is owned by exactly one GitHub organization, and an organization has at
  most one connected private App in a Fabrika installation.
- Fabrika has no explicit connection-count limit. Every individual untrusted payload and every page is
  still bounded.
- A Zerops private application registration and operation carries both `github_connection_id` and
  `github_installation_id`, or neither. This is not a global shared-table constraint: Cloudflare may
  carry `github_installation_id` without a Zerops connection, and migration does not backfill that row.
- The copied singleton is the sole immutable `legacy-v1` connection. Every new connection is immutable
  `keyed-v2`, and deploy protocol selection follows that marker rather than field presence or runtime
  status history.
- Legacy registry backfill requires a matching installation id, at least one Zerops `app_envs` row and
  no non-Zerops `app_envs` row for the app. Mixed-provider evidence is skipped and cannot deploy through
  the Zerops private-source path until repaired explicitly.
- A v2 private-source operation names both a connection id and installation id. Source never selects a
  client by installation id alone and never searches other clients after a mismatch.
- A v2 credential slot is create-only. Its canonical bundle embeds the connection id, and its full
  digest-bound identity must match both the slot name and activation request before source adds it.
- In a Zerops composition, the legacy v1 bundle, v1 source wire and generic webhook path can select
  only the migrated `legacy-v1` connection. New connections cannot fall back to them. Cloudflare keeps
  its existing static-secret and installation-id generic webhook behavior.
- Webhook HMAC verification uses only the secret selected by the scoped path. The verified event can
  trigger only the exact connection, installation and repository binding.
- Outside a nonterminal manifest setup, private keys and GitHub tokens remain only on source. Control
  may transit the bounded plaintext key in memory during callback processing, but the only key material
  it may persist or durably hold is ADR-0031's temporary KEK-encrypted recovery entry, which it deletes
  after source configuration verification. Plaintext never enters a response, log, final connection
  row, app registry state or provider/workflow checkpoint.
- One nonterminal setup or repair workflow may exist globally. Stable connected rows are plural.
- Source remains one active container. Reporting activation complete with multiple source replicas
  still requires a future shared dynamic-configuration mechanism.

## Consequences

- Operators can keep every App private while deploying repositories from several organizations.
- Credential, source-operation and webhook identities become explicit end to end on the Zerops
  private-source path. A numeric installation id alone remains valid for Cloudflare but is not
  sufficient to select a Zerops source credential.
- The legacy path remains deployable during an additive rollout and retains durable evidence, at the
  cost of two compatibility paths and a deliberately unsupported rollback after v2 state exists.
- Source startup and status handling become a keyed collection. One invalid persisted v2 slot blocks
  startup rather than allowing partial credential availability.
- Control gains additive migrations for both SQLite/D1 and PostgreSQL, a registry backfill, paginated
  admin DTOs and exact-pair webhook queries.
- Environment usage grows by one value per connection. There is no aggregate-secret rewrite, but the
  platform's own environment capacity remains an external operational constraint.
- Delete, disconnect and rotation semantics remain undecided. Until a later decision, a connected
  organization and its create-only credential slot are durable installation state.

## Alternatives considered

- **Make one App public and install it in every organization.** Rejected as the required model: it
  expands installability beyond operators who want organization-private Apps. Existing public state
  remains compatible, but public cross-organization routing is not part of this work.
- **Put all credentials in one versioned JSON array.** Rejected: adding one organization would rewrite
  every private key, increase the blast radius of a failed write and violate the create-only custody
  established by ADR-0031.
- **Try every webhook secret until one verifies.** Rejected: work grows with the connection set and the
  route does not bind the request before body processing. The scoped path selects one secret.
- **Route only by repository owner or installation id.** Rejected: owner text is mutable input and the
  installation id does not name the App credential at the source boundary. The persisted connection
  and installation pair is explicit.
- **Replace the singleton schema and v1 environment value in place.** Rejected: it makes rollout
  ordering brittle and destroys the durable evidence needed to keep the live connection compatible.
- **Set an explicit connection-count limit.** Rejected: it is an arbitrary product constraint. Bounded
  pages and individual payloads provide resource safety without defining how many organizations an
  installation may connect.
- **Run one source service per organization.** Rejected for this phase: it multiplies topology,
  deployment and routing state. The approved one-container source service can isolate clients by
  connection id.

## Out of scope

- Deleting, disconnecting or rotating a connection or credential slot.
- Reassigning an application between connections without re-registration.
- Public-App cross-organization installations.
- GitHub Enterprise hosts or API origins.
- More than one active source container.

## References

- [ADR-0029 — An operator-owned GitHub App delivers Zerops application sources](0029-an-operator-owned-github-app-delivers-zerops-sources.md)
- [ADR-0031 — Manage the Zerops GitHub source connection from control](0031-manage-zerops-github-source-from-control.md)
- [Multiple private GitHub source connections sprint](../sprints/sprint-2026-08-14-multiple-private-github-source-connections.md)
