// A public procedure's workload actions in the conservative access diff: its handler holds them for anyone who calls
// it, so a gained action widens with closer review and a lost one narrows. They are no step off the paved road.

import type { ContractArtifact, DeclaredReach } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { classifyAccess, snapshotDeviations } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

function snapshot(actions: readonly string[] | null): AccessSnapshot {
	const contract: ContractArtifact = {
		...notesArtifact,
		declared: actions === null ? { 'api.stats.cta': reach } : { 'api.stats.cta': { ...reach, actions } },
	}
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

describe("a public procedure's workload actions in the approval diff", () => {
	test('a gained action widens with closer review, and is no deviation', () => {
		expect(classifyAccess(snapshot(['notes.read']), snapshot(['notes.read', 'notes.write']))).toEqual({
			outcome: 'widening',
			changes: [{
				effect: 'widens',
				line: 'Endpoint `api.stats.cta` runs as its own workload with `notes.write`, for anyone who calls it',
				review: 'closer',
			}],
		})
		expect(snapshotDeviations(snapshot(['notes.read']))).toEqual([])
	})

	test('a lost action narrows', () => {
		expect(classifyAccess(snapshot(['notes.read', 'notes.write']), snapshot(['notes.read']))).toEqual({
			outcome: 'no-widening',
			changes: [{ effect: 'narrows', line: 'Endpoint `api.stats.cta` no longer runs with `notes.write`' }],
		})
	})

	test('a contract of an older framework, with no workload actions, compares as before', () => {
		expect(classifyAccess(snapshot(null), snapshot(null))).toEqual({ outcome: 'none', changes: [] })
	})
})
