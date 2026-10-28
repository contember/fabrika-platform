// The migrations `migration-edited` compares the tree with: those of the merge base of HEAD and the remote's default
// branch, read with git. Only the bin reads them; a caller with the files of a commit (Control, a deploy build) has no
// history to compare with, and the runner's checksum stays the real check.

import { MIGRATIONS_DIR } from './layout'
import type { MigrationBase } from './rules/migration-history'

/** What the default base is looked up as, in order, when the bin is given no `--base`. */
const DEFAULT_REFS = ['origin/main', 'origin/master']

interface GitResult {
	readonly ok: boolean
	readonly stdout: Uint8Array
}

const git = async (root: string, args: readonly string[], stdin?: string): Promise<GitResult> => {
	const input = stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin)
	const child = Bun.spawn(['git', '-C', root, ...args], { stdin: input, stdout: 'pipe', stderr: 'ignore' })
	const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).arrayBuffer()])
	return { ok: code === 0, stdout: new Uint8Array(stdout) }
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes).trim()

/** The remote's default branch: `origin/HEAD` where the clone recorded it, else the first of `DEFAULT_REFS` that exists. */
const defaultRef = async (root: string): Promise<string | null> => {
	const head = await git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
	if (head.ok && text(head.stdout) !== '') return text(head.stdout)
	for (const ref of DEFAULT_REFS) {
		if ((await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`])).ok) return ref
	}
	return null
}

/** Each regular file directly in `db/migrations/` at `commit`, by its blob id. */
const migrationBlobs = async (root: string, commit: string): Promise<Map<string, string> | null> => {
	const listed = await git(root, ['ls-tree', '-z', commit, '--', MIGRATIONS_DIR])
	if (!listed.ok) return null
	const blobs = new Map<string, string>()
	for (const entry of new TextDecoder().decode(listed.stdout).split('\0')) {
		const match = /^(100644|100755) blob ([0-9a-f]+)\t(.+)$/.exec(entry)
		if (match?.[2] !== undefined && match[3] !== undefined && match[3].endsWith('.sql')) blobs.set(match[3], match[2])
	}
	return blobs
}

/** The blobs' texts, through one `git cat-file --batch`: each answer is `<id> blob <size>\n<bytes>\n`. */
const blobTexts = async (root: string, blobs: ReadonlyMap<string, string>): Promise<Map<string, string> | null> => {
	if (blobs.size === 0) return new Map()
	const ids = [...blobs.values()]
	const batch = await git(root, ['cat-file', '--batch'], ids.map((id) => `${id}\n`).join(''))
	if (!batch.ok) return null
	const decoder = new TextDecoder()
	const texts = new Map<string, string>()
	let offset = 0
	for (const id of ids) {
		const end = batch.stdout.indexOf(10, offset)
		const header = /^([0-9a-f]+) blob (\d+)$/.exec(decoder.decode(batch.stdout.subarray(offset, end)))
		if (end < 0 || header?.[1] !== id || header[2] === undefined) return null
		const size = Number(header[2])
		texts.set(id, decoder.decode(batch.stdout.subarray(end + 1, end + 1 + size)))
		offset = end + 1 + size + 1
	}
	return new Map([...blobs].map(([path, id]) => [path, texts.get(id) ?? '']))
}

/**
 * The migrations at the merge base of HEAD and `ref` (the remote's default branch when omitted), compared against
 * the merge base so that migrations the default branch added since the branch forked are not read as deleted.
 * `null` when `root` is in no git work tree; `{ skipped }` when it is but the base cannot be read.
 */
export const readMigrationBase = async (root: string, ref?: string): Promise<MigrationBase | { readonly skipped: string } | null> => {
	if (!(await git(root, ['rev-parse', '--is-inside-work-tree'])).ok) return null
	const named = ref ?? (await defaultRef(root))
	if (named === null) return { skipped: `no origin/HEAD, ${DEFAULT_REFS.join(' or ')} to compare the migrations with; pass --base <ref>` }
	if (named.startsWith('-') || !(await git(root, ['rev-parse', '--verify', '-q', `${named}^{commit}`])).ok) {
		return { skipped: `${named} names no commit` }
	}
	const mergeBase = await git(root, ['merge-base', 'HEAD', named])
	if (!mergeBase.ok) return { skipped: `HEAD and ${named} share no commit this clone holds` }
	const blobs = await migrationBlobs(root, text(mergeBase.stdout))
	const files = blobs === null ? null : await blobTexts(root, blobs)
	if (files === null) return { skipped: `the migrations of ${named} cannot be read` }
	return { ref: named, files }
}
