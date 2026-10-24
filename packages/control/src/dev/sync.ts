// The files that bring a `dev` container from the head it holds to the head it should serve, relayed from GitHub. Control
// keeps none of them (ADR-0049): it compares the two commits, reads the changed paths at the target, and answers.

import { bootstrapReason } from '@fabrika/app/dev/changes'
import type { DevSourceFile, DevSync } from '@fabrika/app/dev/wire'
import { isSourcePath } from '@fabrika/app/dev/wire'
import { WORKSPACE_READ_MAX_PATHS, type WorkspaceFile, type WorkspaceSourceSession } from '../workspace-source-port'

/** The most files and bytes one sync relays; a larger change needs a bootstrap run. */
export const DEV_SYNC_MAX_FILES = 300
export const DEV_SYNC_MAX_BYTES = 8 * 1024 * 1024

export type DevSyncOutcome =
	| { readonly kind: 'sync'; readonly sync: DevSync }
	/** One line for the agent: why this head cannot be synced and needs a bootstrap run. */
	| { readonly kind: 'refused'; readonly reason: string }

const BOOTSTRAP = 'that needs a bootstrap run: call bind_dev again'

/**
 * Every path that differs between `from` and `to`, at `to`. GitHub compares from the merge base, so when `from` is no
 * ancestor of `to` (another workspace, a rewritten branch) the reverse comparison adds what only `from` changed.
 */
export async function buildDevSync(source: WorkspaceSourceSession, from: string, to: string): Promise<DevSyncOutcome> {
	const changed = await changedPaths(source, from, to)
	if (changed.kind === 'refused') return changed
	const paths = changed.paths

	const files = new Map<string, string | null>()
	let bytes = 0
	let pending = paths
	while (pending.length > 0) {
		const read: WorkspaceFile[] = []
		for (let start = 0; start < pending.length; start += WORKSPACE_READ_MAX_PATHS) {
			read.push(...(await source.readFiles({ commitSha: to, paths: pending.slice(start, start + WORKSPACE_READ_MAX_PATHS) })).files)
		}
		const next: string[] = []
		for (const file of read) {
			if (file.content !== null) {
				bytes += new TextEncoder().encode(file.content).byteLength
				files.set(file.path, file.content)
			} else if (file.reason === 'missing') {
				files.set(file.path, null)
			} else if (file.reason === 'budget') {
				next.push(file.path)
			} else {
				return { kind: 'refused', reason: `${file.path} is ${UNREADABLE[file.reason]} at ${to}, which a sync does not relay; ${BOOTSTRAP}` }
			}
		}
		if (bytes > DEV_SYNC_MAX_BYTES) return { kind: 'refused', reason: `the change from ${from} to ${to} is larger than a sync relays; ${BOOTSTRAP}` }
		// A read that returned nothing but `budget` would never finish.
		if (next.length === pending.length) return { kind: 'refused', reason: `${pending[0]} could not be read at ${to}; ${BOOTSTRAP}` }
		pending = next
	}
	const synced: DevSourceFile[] = paths.map((path) => ({ path, content: files.get(path) ?? null }))
	return { kind: 'sync', sync: { from, to, files: synced } }
}

/**
 * Why a launcher holding `from` cannot sync to `to`, in one line, or null when it may: the paths alone decide, as the
 * launcher's own rule does. A change of the contract digest the launcher still refuses after it writes the files.
 */
export async function syncRefusal(source: WorkspaceSourceSession, from: string, to: string): Promise<string | null> {
	const changed = await changedPaths(source, from, to)
	return changed.kind === 'refused' ? changed.reason : bootstrapReason(changed.paths)
}

/** Every path that differs between `from` and `to`, sorted; refused when a sync could not relay them. */
async function changedPaths(
	source: WorkspaceSourceSession,
	from: string,
	to: string,
): Promise<{ readonly kind: 'paths'; readonly paths: readonly string[] } | { readonly kind: 'refused'; readonly reason: string }> {
	const forward = await source.compare({ baseSha: from, headSha: to })
	const comparisons = forward.behindBy > 0 ? [forward, await source.compare({ baseSha: to, headSha: from })] : [forward]
	if (comparisons.some((comparison) => comparison.filesCapped)) {
		return { kind: 'refused', reason: `the change from ${from} to ${to} lists more files than GitHub compares; ${BOOTSTRAP}` }
	}
	const paths = [
		...new Set(
			comparisons.flatMap((comparison) => comparison.files.flatMap((file) => file.previousPath === null ? [file.path] : [file.path, file.previousPath])),
		),
	].sort()
	if (paths.length > DEV_SYNC_MAX_FILES) {
		return { kind: 'refused', reason: `the change from ${from} to ${to} touches ${paths.length} files, more than a sync relays; ${BOOTSTRAP}` }
	}
	const unsafe = paths.find((path) => !isSourcePath(path))
	if (unsafe !== undefined) return { kind: 'refused', reason: `the path ${JSON.stringify(unsafe)} cannot be synced; ${BOOTSTRAP}` }
	return { kind: 'paths', paths }
}

const UNREADABLE = {
	not_a_file: 'not a regular file',
	too_large: 'over 512 KiB',
	binary: 'not UTF-8 text',
} as const

/**
 * A sync made from the files a commit wrote, when it stays within what a relayed sync may hold; null otherwise, and
 * the compare then decides, with its reason.
 */
export function relayableSync(sync: DevSync): DevSync | null {
	if (sync.files.length > DEV_SYNC_MAX_FILES || sync.files.some((file) => !isSourcePath(file.path))) return null
	const bytes = sync.files.reduce((total, file) => total + (file.content === null ? 0 : new TextEncoder().encode(file.content).byteLength), 0)
	return bytes > DEV_SYNC_MAX_BYTES ? null : sync
}
