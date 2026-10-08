// Runtime-neutral: the Worker reaches this through `metadata.ts`, so it must not import `node:*`.

export const SOURCE_MAX_TREE_ENTRIES = 50_000

export function safeRepositoryPath(path: string): boolean {
	if (
		path === ''
		|| path.startsWith('/')
		|| path.includes('\\')
		|| [...path].some(
			(character) => character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
		)
	) {
		return false
	}
	return path
		.split('/')
		.every((segment) => segment !== '' && segment !== '.' && segment !== '..')
}
