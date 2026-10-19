import { CHECKER_VERSION } from '@fabrika/check/contract'
import type { AnonymousReadability, CommitFilesInput, CommitSource } from '../../github/source/commit-files'
import { healthOnly } from './contracts'

/** A `bun.lock` that resolves `@fabrika/app` from the npm registry at `release`, as `bun install` writes it. */
export const frameworkLockfile = (release: string = CHECKER_VERSION): string =>
	JSON.stringify({
		lockfileVersion: 1,
		workspaces: { '': { name: 'application', dependencies: { '@fabrika/app': release } } },
		packages: { '@fabrika/app': [`@fabrika/app@${release}`, '', {}, `sha512-${'A'.repeat(86)}==`] },
	})

/**
 * Every application root of the tree (a directory with a `fabrika.contract.ts`) gets a `bun.lock` at this release, as
 * an application commits one, unless the tree names its own or a `null` one.
 */
const withLockfiles = (tree: Readonly<Record<string, string | null>>): Readonly<Record<string, string>> => {
	const files: Record<string, string> = {}
	for (const [path, text] of Object.entries(tree)) {
		if (path === 'fabrika.contract.ts' || path.endsWith('/fabrika.contract.ts')) {
			const lockfile = `${path.slice(0, -'fabrika.contract.ts'.length)}bun.lock`
			if (!(lockfile in tree)) files[lockfile] = frameworkLockfile()
		}
		if (text !== null) files[path] = text
	}
	return files
}

/**
 * A commit source over one in-memory tree (repository path → text); the default tree has no contract. A `null` text
 * leaves the path out, which keeps an application root without the `bun.lock` the helper adds otherwise.
 */
export function memoryCommits(
	given: Readonly<Record<string, string | null>> = {},
	readability: AnonymousReadability = 'readable',
): CommitSource & { readonly opened: CommitFilesInput[] } {
	const tree = withLockfiles(given)
	const opened: CommitFilesInput[] = []
	return {
		opened,
		anonymousReadability: () => Promise.resolve(readability),
		open: (input) => {
			opened.push(input)
			return Promise.resolve({
				paths: new Set(Object.keys(tree)),
				read: (path) => {
					const text = tree[path]
					return text === undefined ? Promise.reject(new Error(`no ${path} in the test commit`)) : Promise.resolve(text)
				},
			})
		},
	}
}

/** A commit of application `app` that holds only `healthOnly(app)`, at the application root `root`. */
export const contractCommits = (app: string, root = ''): ReturnType<typeof memoryCommits> =>
	memoryCommits({ [root === '' ? 'fabrika.contract.ts' : `${root}/fabrika.contract.ts`]: healthOnly(app) })
