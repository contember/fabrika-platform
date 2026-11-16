// The member directory an endpoint may read (`ctx.members`) in the approval: the runtime grants it by the access form
// alone, so a new endpoint whose action is its container's `members.list` can list that directory whatever its handler
// does. A reach the approved contract already gives an endpoint of the same action, for the same callers, shows no one
// anything new: its line is neutral and the people mark stays off. A reach no approved endpoint had keeps it.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import type { AccessSnapshot } from '../approval/snapshot'
import { classifyAccess } from './helpers/access'

const DOCUMENTS: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'document', key: 'id', container: { dimension: 'team', column: 'team_id' } },
	actions: { read: 'documents.read', insert: 'documents.write', update: 'documents.write', delete: 'documents.write' },
	insert: ['title'],
	update: ['title'],
	version: null,
	createdBy: null,
	columns: {},
}

const TEAMS: TablePolicyArtifact = {
	scope: { mode: 'dimension', dimension: 'team', key: 'id', container: null },
	actions: { read: 'documents.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}

/**
 * A team whose directory shows labels and whose `members.list` is `documents.read`, the same action that reads its
 * documents: every endpoint reading a document by id can list the team's members.
 */
const contract = (callers: string, procedures: string): string =>
	`import { defineContract, file } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const ById = z.strictObject({ id: z.uuid() })
const Document = z.strictObject({ id: z.uuid(), title: z.string() })

export const contract = defineContract({
	app: 'documents',
	dimensions: {
		team: { creator: 'owner', members: { manage: 'members.manage', list: 'documents.read' }, directory: 'labels' },
		document: { in: 'team' },
	},
	actions: { 'documents.read': 'Read documents', 'documents.write': 'Write documents', 'members.manage': 'Manage members' },
	roles: {
		owner: { grants: ['documents.read', 'documents.write', 'members.manage'], member: { scope: 'team', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: [${callers}] }, {
		get: c.query({ input: ById, output: Document, access: { action: 'documents.read', on: 'document', from: 'id' } }),
${procedures}	}),
	health: c.health('/healthz'),
	files: { rendered: c.files({ types: ['application/pdf'], maxBytes: 1048576 }) },
}))
`

/** A mutation that answers a stored file of the document it names: what a "download as PDF" endpoint declares. */
const RENDER =
	`\t\trender: c.mutation({ input: ById, output: file('rendered'), access: { action: 'documents.read', on: 'document', from: 'id' } }),\n`

const snapshot = (source: string): AccessSnapshot => ({
	version: 1,
	contract: readContractSource(new Map([['fabrika.contract.ts', source]]), { documents: DOCUMENTS, teams: TEAMS }),
	migrations: [],
	checker: '0.0.0',
})

const directoryLines = (baseline: AccessSnapshot, candidate: AccessSnapshot) =>
	classifyAccess(baseline, candidate).changes.filter((change) => change.line.includes(' member'))

describe('the member directory an endpoint may read', () => {
	test('a new endpoint reaching the directory an approved one already lists, for the same callers, needs no closer review', () => {
		const baseline = snapshot(contract("'human', 'machine'", ''))
		const candidate = snapshot(contract("'human', 'machine'", RENDER))
		expect(candidate.contract?.directories).toEqual({
			'api.get': { dimension: 'team', lists: true },
			'api.render': { dimension: 'team', lists: true },
		})
		const { outcome, changes } = classifyAccess(baseline, candidate)
		// The new endpoint still waits for approval: it is new code with a new answer.
		expect(outcome).toBe('widening')
		expect(changes.find((change) => change.line.startsWith('New endpoint `api.render`'))?.effect).toBe('widens')
		expect(changes.filter((change) => change.review === 'closer')).toEqual([])
		expect(directoryLines(baseline, candidate)).toEqual([{
			effect: 'neutral',
			line: 'Endpoint `api.render` can list the members of `team`, as the approved `api.get` already can for the same callers',
		}])
	})

	test('a caller kind no approved endpoint of that reach admitted keeps the closer review', () => {
		const baseline = snapshot(contract("'human'", ''))
		const candidate = snapshot(
			contract("'human'", '').replace(
				'\t}),\n\thealth',
				`\t}),\n\tbots: c.rpc('/bots', { callers: ['machine'] }, {\n${RENDER}\t}),\n\thealth`,
			),
		)
		expect(directoryLines(baseline, candidate)).toEqual([{
			effect: 'widens',
			line: "Endpoint `bots.render` can list the members of `team`, with their labels, which spell users' email addresses",
			review: 'closer',
		}])
	})

	test('an action that reached no member before keeps the closer review', () => {
		const writer = `\t\trename: c.mutation({ input: ById, output: Document, access: { action: 'documents.write', on: 'document', from: 'id' } }),\n`
		const baseline = snapshot(contract("'human'", ''))
		const candidate = snapshot(contract("'human'", writer))
		expect(directoryLines(baseline, candidate)).toEqual([{
			effect: 'widens',
			line: "Endpoint `api.rename` can look up one member of `team`, with their labels, which spell users' email addresses",
			review: 'closer',
		}])
	})

	test('the first endpoint to list a directory keeps the closer review', () => {
		const baseline = snapshot(contract("'human'", '').replace(/\t\tget: .*\n/, ''))
		const candidate = snapshot(contract("'human'", ''))
		expect(directoryLines(baseline, candidate)).toEqual([{
			effect: 'widens',
			line: "Endpoint `api.get` can list the members of `team`, with their labels, which spell users' email addresses",
			review: 'closer',
		}])
	})
})
