import {
	canonicalArtifactJson,
	canonicalizeArtifact,
	canonicalJson,
	type ContractArtifact,
	contractDigest,
	type SchemaShape,
	sha256Hex,
	SHARED_SHAPES_ENCODING,
} from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import {
	type AccessSnapshot,
	approvedProviderAccess,
	approvedSnapshot,
	EMPTY_SNAPSHOT,
	parseSnapshot,
	serializeSnapshot,
	snapshotDigest,
	STORED_SNAPSHOT_BYTES,
} from '../approval/snapshot'

const MIGRATIONS = [{ name: '20260101000000_init.sql', checksum: 'a'.repeat(64) }]

/** A snapshot an application without a contract published before those were refused: its gates and IAM schema. */
const ARTIFACT_PUBLICATION = JSON.stringify({
	version: 1,
	contract: null,
	migrations: MIGRATIONS,
	checker: '0.0.1',
	artifact: {
		gates: { rules: [{ path: '/*', kind: 'human' }] },
		schema: { scopes: [], actions: [{ action: 'notes.read' }], roles: { reader: { name: 'Reader', permissions: ['notes.read'] } } },
	},
})

const published = (snapshotJson: string | null) => ({
	app_id: 'notes',
	env: 'prod',
	published_run_id: snapshotJson === null ? null : 'run-1',
	published_snapshot_json: snapshotJson,
	generation: 4,
})

describe('a stored snapshot after applications without a contract are refused', () => {
	test('a publication that holds artifact access approves nothing: it reads as the empty baseline', () => {
		const active = approvedSnapshot(published(ARTIFACT_PUBLICATION))
		expect(active).toEqual({ runId: null, generation: 4, snapshot: EMPTY_SNAPSHOT })
		expect(approvedProviderAccess(published(ARTIFACT_PUBLICATION))).toEqual({})
	})

	test('the empty unpublished baseline stays valid', () => {
		expect(approvedSnapshot(published(null))).toEqual({ runId: null, generation: 4, snapshot: EMPTY_SNAPSHOT })
		expect(approvedProviderAccess(published(null))).toEqual({})
	})

	test("a run's stored snapshot parses with its artifact access dropped", () => {
		expect(parseSnapshot(ARTIFACT_PUBLICATION)).toEqual({ version: 1, contract: null, migrations: MIGRATIONS, checker: '0.0.1' })
	})

	test('a contract publication stored with `artifact: null` stays approved, with the same digest it was approved under', () => {
		const stored = JSON.stringify({ version: 1, contract: notesArtifact, migrations: MIGRATIONS, checker: '0.0.1', artifact: null })
		const active = approvedSnapshot(published(stored))
		expect(active.runId).toBe('run-1')
		expect(active.snapshot.contract).toEqual(notesArtifact)
		expect(approvedProviderAccess(published(stored)).access?.contract).toEqual(notesArtifact)
		// The digest formula from before: the trailing `null` was the artifact access of a contract snapshot.
		const before = `sha256:${sha256Hex(`${canonicalArtifactJson(notesArtifact)}\n${canonicalJson(MIGRATIONS)}\nnull`)}`
		expect(snapshotDigest(active.snapshot)).toBe(before)
	})

	test('a snapshot is stored without the artifact key', () => {
		expect(JSON.parse(serializeSnapshot(EMPTY_SNAPSHOT))).toEqual({ version: 1, contract: null, migrations: [], checker: '' })
	})
})

describe('a snapshot whose plain form does not fit a row', () => {
	const text: SchemaShape = {
		type: 'string',
		format: null,
		minLength: null,
		maxLength: null,
		pattern: null,
		startsWith: null,
		endsWith: null,
		includes: null,
	}
	const wide: SchemaShape = { type: 'object', fields: Object.fromEntries(Array.from({ length: 6000 }, (_, index) => [`field${index}`, text])) }
	const large: ContractArtifact = {
		...notesArtifact,
		endpoints: notesArtifact.endpoints.map((row) => row.kind === 'query' ? { ...row, output: wide } : row),
	}
	const snapshot: AccessSnapshot = { version: 1, contract: large, migrations: MIGRATIONS, checker: '0.0.1' }

	test('is stored in the shared encoding, and reads back to the same contract and digests', () => {
		expect(JSON.stringify({ ...snapshot }).length).toBeGreaterThan(STORED_SNAPSHOT_BYTES)
		const stored = serializeSnapshot(snapshot)
		expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(STORED_SNAPSHOT_BYTES)
		expect(JSON.parse(stored).contract.encoding).toBe(SHARED_SHAPES_ENCODING)
		const read = parseSnapshot(stored)
		expect(read.contract).toEqual(canonicalizeArtifact(large))
		expect(read.contract === null ? null : contractDigest(read.contract)).toBe(contractDigest(large))
		expect(snapshotDigest(read)).toBe(snapshotDigest(snapshot))
	})

	test('one that fits keeps the plain form an older Control reads', () => {
		const stored = serializeSnapshot({ ...snapshot, contract: notesArtifact })
		expect(JSON.parse(stored).contract).toEqual(notesArtifact)
	})
})
