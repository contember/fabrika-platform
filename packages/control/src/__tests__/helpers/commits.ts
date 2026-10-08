import type { CommitFilesInput, CommitSource } from '../../github/source/commit-files'

/** A commit source over one in-memory tree (repository path → text); the default tree has no contract. */
export function memoryCommits(tree: Readonly<Record<string, string>> = {}): CommitSource & { readonly opened: CommitFilesInput[] } {
	const opened: CommitFilesInput[] = []
	return {
		opened,
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
