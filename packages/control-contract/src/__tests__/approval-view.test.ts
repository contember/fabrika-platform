// The approval page's view of a classification (ADR-0050 §7): it keeps every line, shows every widening without
// expanding anything, folds only what neither widens nor needs closer review, and decides nothing.

import { describe, expect, test } from 'bun:test'
import { type ApprovalView, approvalView, type ChangeRow } from '../approval-view'
import type { AccessChangeDto, ChangeAudienceDto } from '../index'

const anyone: ChangeAudienceDto = { reach: 'anyone', requirement: null }
const staff: ChangeAudienceDto = { reach: 'human', requirement: 'with `candidates.read` (on `candidate`)' }
const student: ChangeAudienceDto = { reach: 'link', mount: 'student', requirement: 'with `candidates.attach` (on `candidate`)' }

function endpoint(
	name: string,
	audience: ChangeAudienceDto,
	line: Partial<AccessChangeDto> & Pick<AccessChangeDto, 'effect' | 'rule'>,
): AccessChangeDto {
	return { line: `Endpoint \`${name}\` ${line.rule}`, subject: { kind: 'endpoint', name, method: 'POST', path: `/${name}` }, audience, ...line }
}

/** Five public procedures, two that start a job; forty signed-in endpoints narrowed to a body limit; a link upload; a migration. */
const intake: AccessChangeDto[] = [
	...['cta', 'interest', 'register', 'resend', 'unsubscribe'].map((name) =>
		endpoint(name, anyone, { effect: 'widens', rule: 'endpoint.added', review: 'closer', reason: 'anyone-calls' })
	),
	endpoint('register', anyone, {
		effect: 'widens',
		rule: 'reach.kicks',
		review: 'closer',
		reason: 'anyone-calls',
		consequence: { kind: 'starts-job', job: 'intake' },
	}),
	...Array.from({ length: 40 }, (_, index) => endpoint(`staff.e${index}`, staff, { effect: 'narrows', rule: 'endpoint.body-limit' })),
	endpoint('staff.files.remove', staff, { effect: 'widens', rule: 'endpoint.added' }),
	endpoint('student.upload', student, { effect: 'widens', rule: 'endpoint.added' }),
	...Array.from({ length: 3 }, (_, index) => endpoint(`staff.e${index}`, staff, { effect: 'neutral', rule: 'procedure.admission' })),
	{
		effect: 'widens',
		line: 'Migration `0002.sql` adopts …',
		rule: 'migration.adopt',
		review: 'closer',
		reason: 'adoption',
		subject: { kind: 'migration', name: '0002.sql' },
	},
	{ effect: 'narrows', line: 'Table `forms` loses …', rule: 'table.read', subject: { kind: 'table', name: 'forms' } },
]

const rowsOf = (view: ApprovalView): ChangeRow[] => [...view.callers, ...view.data].flatMap((entry) => entry.rows)
const linesOf = (rows: readonly ChangeRow[]): AccessChangeDto[] => rows.flatMap((row) => (row.kind === 'line' ? [row.change] : row.changes))

describe('the approval view', () => {
	const view = approvalView(intake)

	test('keeps every line exactly once', () => {
		const shown = [...linesOf(rowsOf(view)), ...view.unsorted]
		expect(shown).toHaveLength(intake.length)
		expect(new Set(shown)).toEqual(new Set(intake))
	})

	test('shows every widening on a row of its own, in a group the page does not collapse', () => {
		for (const entry of [...view.callers, ...view.data]) {
			for (const row of entry.rows) {
				if (row.kind === 'folded') expect(row.changes.every((change) => change.effect !== 'widens' && change.review !== 'closer')).toBe(true)
			}
			expect(entry.collapsed).toBe(!linesOf(entry.rows).some((change) => change.effect === 'widens'))
		}
		const widenings = intake.filter((change) => change.effect === 'widens')
		const inView = [...view.callers, ...view.data].filter((entry) => !entry.collapsed).flatMap((entry) =>
			entry.rows.flatMap((row) => (row.kind === 'line' ? [row.change] : []))
		)
		expect(widenings.every((change) => inView.includes(change))).toBe(true)
	})

	test('groups endpoints by who reaches them, a closer review first, and each link mount apart', () => {
		expect(view.callers.map((entry) => entry.key)).toEqual(['anyone', 'link:student', 'human'])
		expect(view.impact).toEqual({
			callers: [
				{ key: 'anyone', reach: 'anyone', endpoints: 5 },
				{ key: 'link:student', reach: 'link', mount: 'student', endpoints: 1 },
				{ key: 'human', reach: 'human', endpoints: 41 },
			],
			migrations: 1,
		})
		expect(view.data.map((entry) => entry.key)).toEqual(['migration', 'table'])
		expect(view.data.find((entry) => entry.key === 'table')?.collapsed).toBe(true)
	})

	test('folds forty body limits into one row, after the widening that leads the group, and keeps a pair apart', () => {
		const staffRows = view.callers.find((entry) => entry.key === 'human')?.rows ?? []
		expect(staffRows.map((row) => (row.kind === 'line' ? row.change.rule : `${row.rule} ×${row.changes.length}`))).toEqual([
			'endpoint.added',
			'procedure.admission ×3',
			'endpoint.body-limit ×40',
		])
		const pair = approvalView(intake.filter((change) => change.rule !== 'endpoint.body-limit').slice(0, 7))
		expect(rowsOf(pair).every((row) => row.kind === 'line')).toBe(true)
	})

	test('puts lines stored before lines carried facts apart, in their order', () => {
		const stored: AccessChangeDto[] = [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }, {
			effect: 'narrows',
			line: 'Mount `old` is removed',
		}]
		expect(approvalView(stored)).toEqual({ impact: { callers: [], migrations: 0 }, callers: [], data: [], unsorted: stored })
	})
})
