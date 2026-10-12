// A form's `then` in the conservative access diff (ADR-0050 §3): it reaches only a job of the same approved contract,
// which runs under its own declared actions, so declaring, moving or dropping it shows a line and widens nothing; any
// other change of the form still widens.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource } from '@fabrika/check/contract'
import { describe, expect, test } from 'bun:test'
import { classifyAccess } from '../approval/diff'
import type { AccessSnapshot } from '../approval/snapshot'
import { edited } from './helpers/contracts'

const INBOX: TablePolicyArtifact = {
	scope: { mode: 'inbox', form: 'apply' },
	actions: { read: 'intake.read', insert: null, update: null, delete: null },
	insert: [],
	update: [],
	version: null,
	createdBy: null,
	columns: {},
}
const TABLES = { applications: INBOX }

const HEALTH = "health: c.health('/healthz'),"

/** `BASE` with an inbox, two jobs that drain it, and a form that appends to it. */
const FORM = (options: string): string => {
	const vocabulary = edited("'notes.delete': 'Delete notes' },", "'notes.delete': 'Delete notes', 'intake.read': 'Read registrations' },")
	const roles = edited('roles: {', "roles: {\n\t\thr: { grants: ['intake.read'] },", vocabulary)
	return edited(
		HEALTH,
		`${HEALTH}
	apply: c.form('/apply', { input: z.strictObject({ name: z.string() }), appendTo: 'applications'${options} }),
	jobs: {
		welcome: c.cron('* * * * *', { actions: ['intake.read'], scope: 'app' }),
		digest: c.cron('0 3 * * *', { actions: ['intake.read'], scope: 'app' }),
	},`,
		roles,
	)
}

function snapshot(contract: string): AccessSnapshot {
	return { version: 1, contract: readContractSource(new Map([['fabrika.contract.ts', contract]]), TABLES), migrations: [], checker: '0.0.0' }
}

describe("a form's then in the approval diff", () => {
	test('a new then is shown and widens nothing', () => {
		expect(classifyAccess(snapshot(FORM('')), snapshot(FORM(", then: 'welcome'")))).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Form `apply` starts job `welcome` after each accepted submission, beside its schedule' }],
		})
	})

	test('another job, or none, is shown and widens nothing', () => {
		expect(classifyAccess(snapshot(FORM(", then: 'welcome'")), snapshot(FORM(", then: 'digest'"))).changes).toEqual([
			{ widens: false, line: 'Form `apply` starts job `digest` after each accepted submission, beside its schedule' },
		])
		expect(classifyAccess(snapshot(FORM(", then: 'welcome'")), snapshot(FORM('')))).toEqual({
			outcome: 'removal',
			changes: [{ widens: false, line: 'Form `apply` no longer starts job `welcome` after a submission' }],
		})
	})

	test('any other change of a form that kicks a job still widens', () => {
		const classification = classifyAccess(snapshot(FORM(", then: 'welcome'")), snapshot(FORM(", then: 'welcome', rate: { perClient: 60 }")))
		expect(classification.outcome).toBe('widening')
		expect(classification.changes).toEqual([
			{
				widens: true,
				line:
					'Mount `apply` changes from `{"appendTo":"applications","kind":"form","path":"/apply"}` to `{"appendTo":"applications","kind":"form","path":"/apply","rate":{"perClient":60}}`',
			},
		])
	})
})
