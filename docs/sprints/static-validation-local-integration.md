# Static validation — local immutable-source integration

Parent: [static validation sprint](sprint-2026-10-05-static-validation.md).

## Goal and approved boundary

Exercise real source RPC authentication, metadata parsing, descriptor digest and
Git commit admission, archive rewriting, and durable provider attempts through the
local Docker composition. The user approved genuine synthetic Git fixtures,
local-only injected HTTPS-to-HTTP upload transport, emulator codeless/sensitive
evidence updates, smoke corrections, and local test resets. Docker execution is
the leader's later integration step, not part of wave 0 or unit implementation.

Production source policy, source implementation, gates, provider lifecycle, and
module boundaries stay authoritative. The emulator does not build uploaded code.
The separately composed Notes container proves application/access behavior, not
execution of the uploaded fixture. No public platform-facts changes are planned;
local tests assert modeled behavior against the existing recorded evidence.

## Verified starting points

- Confirmed: `source-zerops/src/config.ts:14–21` already accepts metadata,
  download and upload transports. Keep its real repository implementation.
- Confirmed: `source-zerops/src/service.ts:305` checks upload destinations before
  invoking transport; an HTTP wire URL is not acceptable.
- Confirmed: `local-stack/compose.yaml:146` carries a retired mutable source
  setting. Control needs `FABRIKA_ZEROPS_PROXY_SOURCE_JSON`.
- Confirmed: `local-stack/src/zerops-emulator.ts:108–185` lacks immutable
  reservation/upload/build/delete; its absent-version code is obsolete.
- Confirmed: `provider-zerops/src/managed-environment/admission.ts:118–127`
  requires a codeless deployment process and matching active version. Emulator
  import currently supplies only creation; sensitive writes discard their flag.
- Confirmed: `local-stack/src/smoke.ts:217–260` pairs a local subdirectory
  descriptor with a repository-root source contract. Its managed-value check at
  `:358–390` also predates version-bound backing records.
- Reuse: real Git fixture generation and transport examples in
  `source-zerops/src/__tests__/repository.test.ts:816–920`; these helpers are
  test-local, not importable runtime infrastructure.

All package paths above are beneath `packages/`. ADRs 0045, 0046 and 0047 govern
pinning, ownership and cleanup. Their production contracts are not being changed.

## Frozen shared seam

`packages/local-stack/src/local-source-contract.ts` is owned by the leader after
wave 0. Units import it and request changes rather than editing it.

### Fixture manifest

`LocalSourceManifest` has `version: 1`, `platform` and `application`, each a
`LocalSourceFixture`: commit/tree SHA-1, recursive Git tree entries, descriptor
contents/SHA-256, and input tar.gz size/SHA-256. Repository coordinates and
relative archive filenames are fixed exported constants, not caller-selected
paths. Manifest maximum is 1 MiB; each archive has a 4 MiB compressed and expanded
limit; each tree has at most 128 entries. These are local fixture budgets, not
changes to production source limits.

The static schema validates representation. WU1's loader additionally verifies
file length/hash, expanded budget, descriptor digest through the public provider
builder/verifier, and selected setups through `prepareZeropsDescriptor`. Do not
claim schema parsing proves those cross-file identities. GitHub-shaped metadata
still passes through the real source parser and tree admission.

Generate two isolated Git repositories from checked-in fixture inputs, with fixed
identity/timestamps, SHA-1 object format, controlled Git configuration and explicit
file modes. Never use enclosing HEAD, index, dirty source bytes or a remote fetch.
Commit explicitly listed inputs; read descriptor/tree/archive from that commit.
Platform contains `proxy` setup, marker and safe relative symlink. Application
contains root `notesapi` descriptor and marker, with no symlink. Use genuine
`git archive` commit PAX identity. Both metadata and download responses derive
from the same manifest/archive pair. Only the exact commit is a supported ref.

Write generated outputs below `.state/source-fixtures/`, publishing the manifest
last. Reuse only if all bytes/identities validate; reject inconsistent existing
outputs. An intentional fixture revision must not silently replace a persisted
namespace pin. Approved reset is available to the leader for incompatible local
data; units must not reset the stack.

### Upload capability and receipt

The logical upload URL is the exported `LOCAL_SOURCE_UPLOAD_URL` plus the exact
canonical query returned by `localSourceUploadSearch`:

```text
?localVersion=1&appVersionId=<1..128 ASCII identifier>&capability=<64 lowercase hex>
```

The capability is 32 cryptographically random bytes encoded as hex. It is bound
to one reserved version. `parseLocalSourceUploadSearch` rejects unknown,
duplicate, reordered, missing and noncanonical parameters without echoing secrets.
The source transport requires exact logical origin/path, canonical query, PUT,
no userinfo/fragment, and no Authorization header. It maps only this URL to the
fixed private emulator origin plus `LOCAL_SOURCE_UPLOAD_PATH`, retaining the
query, stream, abort signal and redirect refusal. No network fallback. Emulator
upload authenticates this capability, not a PAT; other API routes retain PAT auth.

Persist `LocalSourceUploadGrant` with version ID, SHA-256 of the capability's
ASCII hex string, `deleted`, and optional `LocalSourceUploadReceipt`. Never
persist/log/return the bearer capability in diagnostic state. Compare the presented
capability digest in constant time. Reservation returns its bearer URL once.

A receipt means the complete nonempty compressed request body reached EOF within
4 MiB. Hash/count incrementally; publish the receipt only after successful EOF.
Aborted, oversized or broken bodies produce no new receipt. A retry cannot erase
an earlier complete receipt. Serialize concurrent PUTs per version or refuse the
second with a clearly synthetic local conflict; successful repeats must match
the original receipt. No raw archive bytes enter JSON snapshots. The receipt's
digest covers the uploaded rewritten gzip, NOT the input GitHub tar.gz; it proves
transport completion, not commit identity. Source admission/RPC results prove
commit and descriptor identity. Tests separately inspect the actual output tar.

Deletion removes the app version and persists an inert grant tombstone. A late
valid PUT can complete with 200 but cannot resurrect the version or replace the
active service version. Preserve grants/tombstones across emulator restarts.
Only explicit reset clears this local ledger. Build is never enabled by a grant
alone. Confirm deletion with exact `400 appVersionNotFound`, including build
attempts against the deleted ID (platform reference, deleted-version race witness).

The real platform accepts build submission without uploaded bytes. Do not invent
an HTTP refusal for it. A modeled missing-upload terminal failure must be labeled
synthetic; successful local source-build witnesses require a completed receipt.

## Disjoint dispatch territories

All paths below are relative to `packages/local-stack/`. These explicit roots
replace the earlier broad WU17 allocation for this integration only. Each new
directory includes its tests. No unit writes the shared contract, manifests,
lockfiles, Compose files, docs, barrels, configuration or other packages.

| Unit                   | Exclusive write roots/files                                                                                                                                                              | Concrete task and acceptance                                                                                                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| WU1 fixture            | New `src/local-source-fixtures/**`, new `fixtures/source/**`                                                                                                                             | Generate/load verified real-Git fixture outputs. Prove determinism and rejection of corrupted artifacts without using enclosing HEAD.                                                                                    |
| WU2 emulator           | `src/zerops-emulator.ts`, `src/zerops-emulator/**`, `src/__tests__/zerops-emulator.test.ts`, `src/__tests__/static-validation.test.ts`, new `src/__tests__/immutable-source-emulator/**` | Implement reservation, bounded upload, exact-version build/delete, persisted receipts/tombstones, codeless evidence and sensitive flags. Real API client lifecycle, restart and late-upload witnesses.                   |
| WU3 source composition | New `src/local-source-runtime/**`                                                                                                                                                        | Compose `createSourceRuntime` with fixture metadata/download and mapped upload transports; runnable `server.ts`. Real source admission succeeds and digest/commit/URL negatives fail before build.                       |
| WU4 smoke              | `src/smoke.ts`, `src/smoke-schemas.ts`, new `src/__tests__/immutable-source-integration/**`                                                                                              | Use root fixture identity; assert exact namespace/run/version/digest evidence and managed backing references; kill Control only after durable build submission. Offline real namespace-attempt integration and recovery. |

Leader owns `src/prepare.ts`, preparation tests, `compose.yaml`, package manifest
and lockfile, documentation/navigation and all shared integration edits. Add the
existing workspace `@fabrika/source-zerops` dependency if needed. Wire the source
command to `src/local-source-runtime/server.ts`; preserve private networks and
credential files. Generate/validate fixtures before startup and inject the real
proxy pin in Control's environment. Do not alter browser gate overrides.

### Unit entrypoints (implementations supplied by their owners)

- WU1 `src/local-source-fixtures/fixture.ts`:
  `prepareLocalSourceFixtures(directory: string): Promise<LocalSourceManifest>`
  and `loadLocalSourceFixtures(directory: string): Promise<LocalSourceManifest>`.
  `directory` is the fixture directory itself, not its parent. Preparation knows
  its checked-in inputs by module-relative path. Loading performs all integrity
  checks; callers use fixed archive filenames to open already verified files.
- WU3 `src/local-source-runtime/runtime.ts`:
  `createLocalSourceRuntime(input: { fixtureDirectory: string; env: SourceEnvironment;
  uploadFetch?: SourceUploadFetch }): Promise<SourceRuntime>`.
  The optional fetch is the final private HTTP transport for offline emulator
  tests, not a replacement for URL checks. Default is normal fetch to the fixed
  emulator destination. Metadata/download transports have no external fallback.
  Server derives the fixture directory from the existing local `.state` path.
- WU2 retains `createZeropsEmulator(options)` and its request-handler API.
  Tests route WU3's final HTTP transport to that handler; no new server is needed.
- WU4 consumes these entrypoints and the public provider clients. Read retained
  provider state through existing codecs rather than duplicating provider schemas.

## Sequence and acceptance

Wave 0 freezes this document and shared contract after scoped formatting, lint
and local-stack TypeScript checking. WU1/WU2 can run concurrently; WU3 can start
against the frozen WU1 signature. WU4 may inspect/prepare tests immediately, but
its execution depends on WU1–WU3 and leader wiring. Owners stop and ask if a seam
needs changing. No unit commits.

Offline witnesses, before Docker:

1. Fixture repeat generation yields identical commits, metadata and archive bytes;
   corrupted descriptor/archive, unknown coordinate/ref and budget overflow fail.
2. Real source resolve/upload verifies commit, descriptor, tree and tar admission.
   Wrong metadata SHA, wrong descriptor digest, wrong PAX commit and unsafe link
   never become successful source uploads/builds. Capture destination tar bytes.
3. Real API client reserves/uploads/builds/observes one ID. Snapshot round-trip
   preserves new states and old snapshots; sensitive and codeless admission works.
4. Hold PUT open, delete its reservation, finish PUT, restart emulator: exact
   version stays absent/unbuildable and previous active version survives.
5. Real namespace attempt persists exact pin/version. Recovery observes a submitted
   version without a second reservation/build; pre-trigger cleanup confirms absence.

Leader Docker witnesses: fresh namespace provision and root-fixture registration;
exact proxy pin and completed app run; correct version-bound managed references;
Control hard-kill after durable submission and same-version exactly-once recovery;
existing IAM, Notes, Operations and network-isolation assertions. Existing legacy
state must be diagnosed, never silently adopted; user approved local test reset.

Run scoped tests, format/lint, typecheck and release dependency validation after
integration. CPU-heavy checks use `cpu-lease`. Passing local tests does not upgrade
any live-only Zerops extraction, runtime environment or infrastructure fact.

## Wave 0 record

Only this document and `local-source-contract.ts` are written by the seam owner.
Verification and exact dispatch readiness are reported to the leader in chat.
