// Process-only: the archive pass hashes with `node:crypto`. The shared layer must not import this file
// (`entrypoint-isolation.test.ts`).

import type { ArchiveSummary, CollectedFiles } from './archive'
import { anonymousReadability, type CommitSource, repositoryOf } from './commit-files'
import { atStage, cancelled, SourceFailure } from './failure'
import type { GitHubMetadataClient } from './metadata'
import type { TarballRepositorySource } from './repository'
import { SOURCE_TIMEOUTS_MS } from './transport'

/** A wanted file above this is refused when read: no snapshot reader accepts more. */
const MAX_KEPT_FILE_BYTES = 1024 * 1024
/** Wanted files beyond this total are read one by one through the contents API instead. */
const MAX_KEPT_BYTES = 32 * 1024 * 1024

/**
 * A commit's files from ONE pass over its archive, which GitHub's REST rate limit does not count (ADR-0029): every path,
 * and the text of the files the caller wants. A wanted file past the memory budget, or a file nobody declared wanted, is
 * read alone through the contents API. The archive is `git archive` output, so an `export-ignore` path is absent, as it
 * is from the deploy.
 */
export function archiveCommitSource(source: TarballRepositorySource, metadata: GitHubMetadataClient): CommitSource {
	return {
		async open(input) {
			const repository = repositoryOf(input.repoUrl)
			const binding = input.sourceBinding
			const wanted = input.wanted ?? (() => false)
			const at = { repository, commitSha: input.commitSha, ...(binding === undefined ? {} : { privateBinding: binding }) }
			let summary: ArchiveSummary
			try {
				summary = await source.read({
					...at,
					ref: input.commitSha,
					expectedCommitSha: input.commitSha,
					collect: { keep: wanted, maxFileBytes: MAX_KEPT_FILE_BYTES, maxBytes: MAX_KEPT_BYTES },
					signal: AbortSignal.any([input.signal, AbortSignal.timeout(SOURCE_TIMEOUTS_MS.resolve)]),
				})
			} catch (error) {
				if (input.signal.aborted) throw cancelled('resolve')
				if (error instanceof SourceFailure && error.code === 'cancelled') throw new SourceFailure('internal', 'resolve')
				throw atStage(error, 'resolve')
			}
			const files = collected(summary)
			return {
				paths: files.paths,
				async read(path, maxBytes) {
					if (files.oversized.has(path)) throw new SourceFailure('archive_rejected', 'resolve')
					const bytes = files.contents.get(path) ?? await source.readFile({ ...at, signal: input.signal }, path, maxBytes)
					if (bytes.byteLength > maxBytes) throw new SourceFailure('archive_rejected', 'resolve')
					try {
						return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
					} catch {
						throw new SourceFailure('archive_rejected', 'resolve')
					}
				},
			}
		},
		anonymousReadability: (input) => anonymousReadability(metadata, input),
	}
}

function collected(summary: ArchiveSummary): CollectedFiles {
	if (summary.files === undefined) throw new SourceFailure('internal', 'resolve')
	return summary.files
}
