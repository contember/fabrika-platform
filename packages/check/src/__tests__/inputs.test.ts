// The files a caller reads at a commit so that the reader sees exactly what it would see in the whole tree.

import { describe, expect, test } from 'bun:test'
import { contractReaderInputs, ContractSourceError, readContractSource } from '../contract'
import { CLEAN_APPLICATION } from './helpers'

/** Read a commit the way Control does: ask, read the answer, ask again until nothing is missing. */
function readAsControl(tree: Readonly<Record<string, string>>): Map<string, string> {
	const exists = (path: string): boolean => Object.hasOwn(tree, path)
	const files = new Map<string, string>()
	for (let round = 0; round < 20; round++) {
		const missing = contractReaderInputs(files, exists)
		if (missing.length === 0) return files
		for (const path of missing) files.set(path, tree[path] ?? '')
	}
	throw new Error('the inputs did not converge')
}

const REPOSITORY: Readonly<Record<string, string>> = {
	...CLEAN_APPLICATION,
	'package.json': '{ "name": "notes" }',
	'tsconfig.json': '{ "extends": "./tsconfig.base", "compilerOptions": { "strict": true } }',
	'tsconfig.base.json': '{ "extends": "./config/shared.json" }',
	'config/shared.json': '{}',
	'src/package.json': '{ "type": "module" }',
	'src/schemas/tsconfig.json': '{}',
	'bunfig.toml': '[test]\npreload = ["./setup.ts"]\n',
	'src/server.ts': "import { contract } from '../fabrika.contract'\n",
	'src/other/package.json': '{}',
	'README.md': '# notes',
	'zerops.yaml': 'zerops: []\n',
}

describe('contractReaderInputs', () => {
	test('names the contract graph, the tables graph and the configuration that applies to them, and nothing else', () => {
		expect([...readAsControl(REPOSITORY).keys()].sort()).toEqual([
			'bunfig.toml',
			'config/shared.json',
			'fabrika.contract.ts',
			'package.json',
			'src/db/schema.generated.ts',
			'src/db/tables.ts',
			'src/package.json',
			'src/schemas/notes.ts',
			'src/schemas/tsconfig.json',
			'src/vocabulary.ts',
			'tsconfig.base.json',
			'tsconfig.json',
		])
	})

	test('the reader reads the same artifact from those files as from the whole tree', () => {
		const whole = new Map(Object.entries(REPOSITORY))
		expect(readContractSource(readAsControl(REPOSITORY))).toEqual(readContractSource(whole))
	})

	test('every candidate of an extensionless import is read, so the reader refuses the ambiguity as in the whole tree', () => {
		const tree = { ...CLEAN_APPLICATION, 'src/schemas/notes.tsx': 'export const Note = 1\n' }
		const files = readAsControl(tree)
		expect(files.has('src/schemas/notes.ts') && files.has('src/schemas/notes.tsx')).toBe(true)
		expect(() => readContractSource(files)).toThrow(ContractSourceError)
	})

	test('a configuration that redirects a trusted package is read and refused', () => {
		const tree = { ...CLEAN_APPLICATION, 'src/schemas/tsconfig.json': '{ "compilerOptions": { "paths": { "zod/*": ["./fake/*"] } } }' }
		expect(() => readContractSource(readAsControl(tree))).toThrow(ContractSourceError)
	})

	test('an application without a contract needs no file', () => {
		expect(contractReaderInputs(new Map(), (path) => path === 'README.md')).toEqual([])
	})
})
