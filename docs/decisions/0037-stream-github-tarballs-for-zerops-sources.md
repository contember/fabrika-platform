---
id: 0037
title: Stream GitHub tarballs for Zerops sources
status: accepted
date: 2026-08-21
---

# 0037 — Stream GitHub tarballs for Zerops sources

## Context

[ADR-0029](0029-an-operator-owned-github-app-delivers-zerops-sources.md) gave the `source` service one
job — turn a repository at an exact commit into the archive Zerops uploads — and one bold invariant
about how: _`source` packages directly from Git objects. It never checks out or extracts the
repository._ That invariant was written to keep application code and local files out of the archive.
The mechanism it named is what this decision replaces.

The Git-object path cost about 1,560 lines across `repository.ts` and `github-metadata.ts`. Every
deploy read the repository twice — once as a recursive GitHub REST tree, then again as Git objects —
and reconciled the two. It shelled out to `git init --bare`, `git fetch`, `git rev-parse`,
`git ls-tree`, `git rev-list` and one `git cat-file` per file, each in a hand-built isolated child
environment carrying the installation token, each with its own timeout and kill path. It needed a
temp directory holding a partial clone plus the assembled tar: two copies of the repository on the
`source` service's disk for the life of a job.

The memory argument for that design does not survive inspection. The tar was always written to disk
first and only then streamed through gzip to the upload URL, so the peak was disk, not RAM. Nothing
downstream depends on the result being byte-deterministic: `control` compares only `runId`,
`appVersionId`, `commitSha` and `descriptorSha256`, and neither
`packages/provider-zerops/src/source.ts` nor `packages/control/src/node/source-client.ts` reads an
entry count or an expanded-byte total.

GitHub already publishes the archive we were assembling. `GET /repos/{owner}/{repo}/tarball/{sha}` is
`git archive` output — a gzipped ustar stream with a pax global header naming the commit — served from
`codeload.github.com` behind a redirect. Fetching it costs one request and no disk.

## Decision

We amend ADR-0029's packaging mechanism. Its ownership boundary is unchanged: the operator installs
the platform, `source` only transports bytes, and Zerops executes every application build and deploy.
The RPC contract with `control` — request and response shapes, failure codes, upload-URL validation,
RPC auth and deadlines — is unchanged.

`source` no longer uses git, a temp directory, or the recursive tree endpoint.

**Resolve** reads two bounded REST responses: the commit for the requested ref, then the root
`zerops.yaml` through `/contents` with `Accept: application/vnd.github.raw+json`, whose SHA-256 must
equal the digest registered in the provider artifact.

**Archive and upload are now one streamed operation.** `source` requests the tarball from
`api.github.com` with `redirect: 'manual'`, requires the `Location` to be exactly
`https://codeload.github.com`, and fetches that URL **without** the installation Authorization header.
The response is piped `gunzip → tar rewrite → gzip → PUT`, so no repository byte is ever buffered
whole, staged on disk, or held beyond one chunk.

The tar rewrite is a hand-written 512-byte-block transform. It strips the single archive prefix, keeps
regular files only, drops directory entries, and rewrites each header with mode `0755` or `0644`, uid
and gid `0`, and a fixed mtime. It confirms the commit from the pax global header's `comment`, hashes
the root `zerops.yaml` as it passes, and enforces the entry-count and expanded-byte limits
incrementally. It holds at most one header block plus one bounded pax record.

**Invariants** — carried forward from ADR-0029 unless marked new:

- `source` receives no Zerops access token and returns no repository content. A job stays bound to one
  repository, exact commit, app version, upload URL and Fabrika run.
- `source` never extracts the repository to disk and never executes repository code. It rejects
  symlinks, hard links, devices, GNU long-name entries, every other special typeflag, a root
  `.gitmodules` (a repository with submodules), paths outside the single archive prefix, duplicate
  paths, and trees above 50,000 files or 512 MiB of content.
- Production origins are fixed to `api.github.com` and — **new** — `codeload.github.com`, HTTPS, no
  port and no userinfo. Injected transports exist only as test seams.
- The codeload URL carries its own short-lived token in the query. Like the Zerops upload URL, it is a
  credential in transit: never logged, never persisted, never returned in an error. Every upstream
  error is redacted before it can reach a run log.
- The upload destination check is unchanged: HTTPS `proxy.app-prg1.zerops.io`, exact path, signed
  query, no redirects.
- **New:** a validation failure can now abort a PUT that is already in flight. `source` settles the
  archive verdict before it blames the transport, so `control` still receives `archive_rejected`,
  `descriptor_missing`, `descriptor_mismatch` or `commit_mismatch` with the same retryable flag as
  before. Every such failure is pre-trigger, and ADR-0029 already requires `control` to delete the app
  version on every pre-trigger failure.
- **New:** `.gitattributes` `export-ignore` and `export-subst` now apply, because the tarball is
  `git archive` output. A repository can therefore keep a path out of its own deploy archive.
- **New:** archives are no longer byte-deterministic across runs, and nothing depends on that. The
  digest that binds a deploy is the descriptor's, not the archive's.

## Consequences

- `source` shrinks to a stream: no subprocesses, no `PATH` assumptions, no temp-directory lifecycle, no
  per-file process spawn, and no second read of the repository to reconcile.
- The `source` service no longer needs `git` in its runtime image, and its disk stops scaling with
  repository size. Peak memory is one chunk.
- Fabrika inherits GitHub's tarball semantics, including `export-ignore`. A repository that hides a
  path from `git archive` now hides it from its deploy, which is a behaviour change for anyone who set
  that attribute expecting it to affect only source distribution.
- The archive is validated while it is being uploaded, so a rejected repository leaves a partially
  written app version behind. That is the same cleanup path an upload transport failure already took.
- One more fixed origin (`codeload.github.com`) joins the trust boundary, and one more credential
  shape (a query-string token) must never be logged.
- GitHub's tarball redirect is now a dependency. A change to its status, target host or archive format
  fails the deploy loudly at the redirect check rather than silently producing a wrong archive.

## Alternatives considered

### Keep the Git-object path

It is written, tested and live. Rejected because its central justification — bounded memory — was
never what it delivered; the tar was on disk either way. It keeps 1,560 lines, a git dependency, two
repository copies per job and a double read of every tree to buy determinism nothing consumes.

### Download the tarball to disk, then upload it

A smaller change: same tarball, but staged as a file so validation completes before the PUT begins.
Rejected because it keeps the temp-directory lifecycle and the disk ceiling that motivated the rewrite,
and buys only an error-ordering convenience that settling the archive verdict already provides.

### Let the Zerops build container fetch the source

Zerops could clone the repository itself during the build. Rejected because a build container cannot
read env-API variables, so the credential would have to travel in `zeropsYaml` or `userData` — exactly
the credential crossing ADR-0029 refused, and this time recorded in platform state.
