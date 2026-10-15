import type { AnonymousReadability, CommitFilesInput, CommitSource } from '../../github/source/commit-files'
import { healthOnly } from './contracts'

/** A commit source over one in-memory tree (repository path → text); the default tree has no contract. */
export function memoryCommits(
	tree: Readonly<Record<string, string>> = {},
	readability: AnonymousReadability = 'readable',
): CommitSource & { readonly opened: CommitFilesInput[] } {
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
