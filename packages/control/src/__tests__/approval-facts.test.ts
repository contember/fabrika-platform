// The facts each line of the access diff carries beside its words (ADR-0050 §3): the comparison that produced it, what
// it is about, who reaches an endpoint, why a line needs closer review and what a call sets off. The words are the other
// approval tests'; these hold the structure the approval page groups by.

import type { ContractArtifact, DeclaredReach, EndpointRow, ProcedureArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { type AccessChange, classifyAccess } from '../approval/diff'
import { parseClassification } from '../approval/publish'
import { type AccessSnapshot, EMPTY_SNAPSHOT } from '../approval/snapshot'

const reach: DeclaredReach = { sql: null, unscoped: {}, connect: [], issues: null }

const CTA: EndpointRow = {
	id: 'api.stats.cta',
	source: { kind: 'mount', name: 'api' },
	kind: 'public',
	method: 'POST',
	path: '/api/stats.cta',
	callers: [],
	requirement: null,
	admission: { contentTypes: ['application/json'], maxBytes: 1024 },
	input: { type: 'object', fields: {} },
	output: { type: 'object', fields: {} },
}

const RULES: ProcedureArtifact = {
	rate: { perClient: 10, perCaller: null, perEndpoint: 100, bytesPerHour: null },
	challenge: null,
	timeoutMs: 10_000,
}

function snapshot(contract: ContractArtifact): AccessSnapshot {
	return { version: 1, contract, migrations: [], checker: '0.0.0' }
}

/** The notes contract with a public procedure that kicks the `digest` job. */
const withCta: ContractArtifact = {
	...notesArtifact,
	endpoints: [...notesArtifact.endpoints, CTA],
	declared: { [CTA.id]: { ...reach, actions: ['notes.write'], kicks: ['digest'] } },
	procedures: { [CTA.id]: RULES },
}

const base = snapshot({ ...notesArtifact, declared: {} })

function lineOf(changes: readonly AccessChange[], prefix: string): AccessChange {
	const found = changes.find((change) => change.line.startsWith(prefix))
	if (found === undefined) throw new Error(`no line starts with ${prefix}`)
	return found
}

describe('the facts of a change line', () => {
	test('every line names its rule and subject, and every closer-review line its reason', () => {
		const { changes } = classifyAccess(EMPTY_SNAPSHOT, snapshot(withCta))
		expect(changes.length).toBeGreaterThan(10)
		for (const change of changes) {
			expect(change.rule).toMatch(/^[a-z-]+\.[a-z-]+$/)
			expect(change.subject.name.length > 0 || change.subject.kind === 'application').toBe(true)
			if (change.review === 'closer') expect(change.reason).toBeDefined()
			else expect(change.reason).toBeUndefined()
		}
	})

	test('a new public procedure is an endpoint anyone reaches, under its route, for closer review because anyone calls it', () => {
		const { changes } = classifyAccess(base, snapshot(withCta))
		expect(lineOf(changes, 'New endpoint `api.stats.cta`')).toMatchObject({
			rule: 'endpoint.added',
			subject: { kind: 'endpoint', name: 'api.stats.cta', method: 'POST', path: '/api/stats.cta' },
			audience: { reach: 'anyone', requirement: null },
			review: 'closer',
			reason: 'anyone-calls',
		})
		expect(lineOf(changes, 'Endpoint `api.stats.cta` starts job `digest`')).toMatchObject({
			rule: 'reach.kicks',
			subject: { kind: 'endpoint', name: 'api.stats.cta' },
			reason: 'anyone-calls',
			consequence: { kind: 'starts-job', job: 'digest' },
		})
		expect(lineOf(changes, '`api.stats.cta` admits')).toMatchObject({ rule: 'procedure.admission', effect: 'neutral' })
	})

	test("a removed endpoint is placed by the baseline's row: who reached it, and its link mount", () => {
		const shared = notesArtifact.endpoints.find((row) => row.id === 'shared.note')
		if (shared === undefined) throw new Error('the fixture has no shared.note')
		const without = { ...notesArtifact, declared: {}, endpoints: notesArtifact.endpoints.filter((row) => row.id !== 'shared.note') }
		const removed = lineOf(classifyAccess(base, snapshot(without)).changes, 'Endpoint `shared.note`')
		expect(removed).toMatchObject({
			rule: 'endpoint.removed',
			subject: { kind: 'endpoint', name: 'shared.note', method: shared.method, path: shared.path },
			audience: { reach: 'link', mount: 'shared', requirement: 'with `notes.read` (on `note`)' },
		})
	})

	test('a line about a table, a role or the application has no audience', () => {
		const role = notesArtifact.roles.editor
		if (role === undefined) throw new Error('the fixture has no editor role')
		const changed = { ...notesArtifact, declared: {}, roles: { ...notesArtifact.roles, editor: { ...role, grants: [...role.grants, 'notes.delete'] } } }
		const gained = lineOf(classifyAccess(base, snapshot(changed)).changes, 'Role `editor` gains')
		expect(gained).toEqual({
			effect: 'widens',
			line: 'Role `editor` gains `notes.delete`',
			rule: 'role.grants',
			subject: { kind: 'role', name: 'editor' },
		})
	})

	test('a stored classification keeps the facts, and one stored before them reads as plain lines', () => {
		const { outcome, changes } = classifyAccess(base, snapshot(withCta))
		const stored = {
			outcome,
			changes,
			candidateDigest: `sha256:${'a'.repeat(64)}`,
			baselineDigest: `sha256:${'b'.repeat(64)}`,
			baselineRunId: null,
			protected: true,
		}
		expect(parseClassification(JSON.stringify(stored)).changes).toEqual(changes)
		const before = { ...stored, changes: [{ effect: 'widens', line: 'New endpoint `api.stats.cta`', review: 'closer' }] }
		expect(parseClassification(JSON.stringify(before)).changes).toEqual([{ effect: 'widens', line: 'New endpoint `api.stats.cta`', review: 'closer' }])
	})
})
