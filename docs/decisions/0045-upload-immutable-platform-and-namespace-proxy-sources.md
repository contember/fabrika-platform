---
id: 0045
title: Upload immutable installation and namespace proxy sources
status: accepted
date: 2026-10-02
---

# 0045 — Upload immutable installation and namespace proxy sources

## Context

The installation sidecar checks out a published tag, but Zerops previously obtained service sources
independently through `buildFromGit`. Live tag- and SHA-suffix probes built default-branch bytes,
including on a fresh service. The tested selector therefore did not bind the deployed code to the
operator's selected release. The measurements live in the Zerops platform reference.

Namespace proxies have the same problem. Their persisted source is reused by initial provisioning,
reconciliation, application deployment and registry-triggered manifest rebuilds. Fixing installation
CI alone would leave those rebuilds mutable.

## Decision

Installation `platform install` and `platform deploy` require an explicit full checkout through
`--source-dir`. Refuse the mutable Git-source installation path rather than retaining it as a fallback.
The generated sidecar passes its checked-out repository root. The published installer package is not
itself a full platform source archive.

Prepare one committed snapshot before any remote mutation, including first-install project creation.
Reject tracked changes and disagreement between the executing installation code and the selected
source. Obtain the build descriptor from the same snapshot, verify its archived bytes, and validate
every selected setup before writes. Exclude checkout credentials and untracked or ignored files.
Preserve tracked symlinks without dereferencing them; refuse submodules instead of silently omitting
their source. Git export attributes must not invalidate source/descriptor identity.

**Invariant:** every installation service build uses that one snapshot and an explicitly reserved
application-version ID: reserve, upload, build the reserved version, then observe that version.
Both first-install passes share the snapshot. Preserve concurrent IAM/Operations/source builds,
followed by proxy and then Control. A failed source preparation cannot fall back to a Git pipeline.
An ambiguous build response cannot justify deleting the version or submitting another build.

Each namespace stores its own immutable proxy source identity: public repository coordinates, full
commit SHA, and the descriptor identity needed to verify and submit the build. Namespace planning
copies the installation owner's selected default. Every subsequent proxy rebuild uses the persisted
identity, not a new default from an upgraded Control process.

The existing source service transports the exact public commit to the reserved proxy version. Its
platform-archive path supports validated safe relative symlinks; this does not silently relax the
application-archive contract. Provisioning checkpoints represent upload and submission ambiguity.
Registry-triggered rebuild requests may wait for a bounded archive upload before reporting that the
build started.

Legacy unpinned namespace records remain inspectable. An operator must select an explicit pin before
conversion; neither a bare URL nor the disproven suffix establishes a historical commit. Do not
backfill current HEAD or replace a stored namespace pin during ordinary reconciliation.

This amends ADR-0025's source-selection mechanism and ADR-0029's remaining allowance for mutable
platform/proxy Git builds. The operator-owned installation repository and source-service boundary
remain in place.

## Consequences

- A published tag remains the operator's release choice; the resolved snapshot identifies the code
  actually submitted to Zerops.
- Installation commands need a full checkout and fail before writes when it cannot be verified.
- A namespace can deliberately retain an older proxy revision through a Control upgrade.
- Proxy upload adds bounded work to registry-triggered rebuild requests.
- Existing unpinned namespaces need an explicit migration decision; no automatic historical identity
  is fabricated.
- Implementation acceptance requires live upload/build byte witnesses. Schema validation and a
  successful archive unit test do not establish Zerops extraction behavior.
