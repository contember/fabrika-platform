import { describe, expect, test } from 'bun:test'
import type { ContractArtifact, SchemaShape } from '../contract'
import { canonicalArtifactJson, canonicalizeArtifact, tableActions } from '../contract-canonical'
import { contractDigest } from '../endpoint-digest'
import { notesArtifact } from './fixtures/notes-artifact'

/** Every key order and every unordered list of the artifact reversed. */
function reversed(artifact: ContractArtifact): ContractArtifact {
	const flip = <T>(record: Readonly<Record<string, T>>): Record<string, T> => Object.fromEntries(Object.entries(record).reverse())
	return {
		...(artifact.directories === undefined ? {} : { directories: flip(artifact.directories) }),
		reservedPrefixes: [...artifact.reservedPrefixes].reverse(),
		endpoints: [...artifact.endpoints].reverse().map((row) => ({
			...row,
			admission: row.admission === null ? null : { maxBytes: row.admission.maxBytes, contentTypes: row.admission.contentTypes },
		})),
		tables: flip(artifact.tables),
		csp: artifact.csp,
		imports: flip(artifact.imports),
		exports: flip(artifact.exports),
		jobs: flip(artifact.jobs),
		files: flip(artifact.files),
		mounts: flip(artifact.mounts),
		roles: Object.fromEntries(Object.entries(artifact.roles).reverse().map(([name, role]) => [name, { ...role, grants: [...role.grants].reverse() }])),
		actions: flip(artifact.actions),
		dimensions: flip(artifact.dimensions),
		app: artifact.app,
		format: artifact.format,
	}
}

describe('canonicalArtifactJson', () => {
	test('is the same bytes for an artifact whose keys and unordered lists are reordered', () => {
		expect(canonicalArtifactJson(reversed(notesArtifact))).toBe(canonicalArtifactJson(notesArtifact))
	})

	test('sorts endpoints by id and lists by code unit, and is idempotent', () => {
		const canonical = canonicalizeArtifact(reversed(notesArtifact))
		const ids = canonical.endpoints.map((row) => row.id)
		expect(ids).toEqual([...ids].sort())
		expect(canonical.roles['owner']?.grants).toEqual(['notes.admin', 'notes.delete', 'notes.read', 'notes.share', 'notes.write'])
		expect(canonicalArtifactJson(canonical)).toBe(canonicalArtifactJson(notesArtifact))
	})

	test('keeps the order of union options and tuple items, which changes what a schema admits', () => {
		const a: SchemaShape = { type: 'null' }
		const b: SchemaShape = { type: 'boolean' }
		const withOutput = (output: SchemaShape): ContractArtifact => ({
			...notesArtifact,
			endpoints: notesArtifact.endpoints.map((row) => (row.id === 'api.me' ? { ...row, output } : row)),
		})
		expect(canonicalArtifactJson(withOutput({ type: 'union', options: [a, b] }))).not.toBe(
			canonicalArtifactJson(withOutput({ type: 'union', options: [b, a] })),
		)
		expect(canonicalArtifactJson(withOutput({ type: 'tuple', items: [a, b], rest: null }))).not.toBe(
			canonicalArtifactJson(withOutput({ type: 'tuple', items: [b, a], rest: null })),
		)
	})
})

describe('table actions', () => {
	test('a table whose every operation names one action keeps the encoding it had before a table action took a list', () => {
		// The digest the fixture had before lists existed, with the format field it gained after: the 0.5 digest itself is
		// framework-compat.test.ts's, read by the 0.5 reader.
		expect(contractDigest(notesArtifact)).toBe('sha256:dad8ca49edae6e5d84b9ea45fde5657e53385301b917efbf68e659457c178940')
	})

	test('a list of actions is sorted, and one action stays its text', () => {
		const notes = notesArtifact.tables['notes']
		if (notes === undefined) throw new Error('the fixture has a notes table')
		const listed: ContractArtifact = {
			...notesArtifact,
			tables: { ...notesArtifact.tables, notes: { ...notes, actions: { ...notes.actions, read: ['notes.read', 'notes.admin'] } } },
		}
		const reordered: ContractArtifact = {
			...notesArtifact,
			tables: { ...notesArtifact.tables, notes: { ...notes, actions: { ...notes.actions, read: ['notes.admin', 'notes.read'] } } },
		}
		expect(canonicalizeArtifact(listed).tables['notes']?.actions.read).toEqual(['notes.admin', 'notes.read'])
		expect(canonicalArtifactJson(listed)).toBe(canonicalArtifactJson(reordered))
		expect(canonicalizeArtifact(notesArtifact).tables['notes']?.actions.read).toBe('notes.read')
	})

	test('tableActions reads one action, a list, and none alike', () => {
		expect(tableActions('notes.read')).toEqual(['notes.read'])
		expect(tableActions(['notes.read', 'notes.admin'])).toEqual(['notes.read', 'notes.admin'])
		expect(tableActions(null)).toEqual([])
	})
})
