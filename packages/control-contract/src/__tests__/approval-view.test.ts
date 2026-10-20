// The approval page's view of a classification (ADR-0050 §7): it keeps every line, shows every widening without
// expanding anything, folds only quiet subjects that changed alike, and decides nothing.

import { describe, expect, test } from 'bun:test'
import { type ApprovalView, approvalView, type ChangeRow, rowChanges } from '../approval-view'
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

/**
 * Five public procedures, one that starts a job; forty signed-in endpoints narrowed to a body limit, three of them with
 * their admission shown too; a new signed-in endpoint; a link upload; an adopting migration; a table.
 */
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
	...Array.from(
		{ length: 40 },
		(_, index) => endpoint(`staff.e${String(index).padStart(2, '0')}`, staff, { effect: 'narrows', rule: 'endpoint.body-limit' }),
	),
	...Array.from({ length: 3 }, (_, index) => endpoint(`staff.e0${index}`, staff, { effect: 'neutral', rule: 'procedure.admission' })),
	endpoint('staff.files.remove', staff, { effect: 'widens', rule: 'endpoint.added' }),
	endpoint('student.upload', student, { effect: 'widens', rule: 'endpoint.added' }),
	{ effect: 'widens', line: 'New migration `0002.sql`', rule: 'migration.added', subject: { kind: 'migration', name: '0002.sql' } },
	{ effect: 'narrows', line: 'Migration `0001.sql` is removed', rule: 'migration.removed', subject: { kind: 'migration', name: '0001.sql' } },
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
const label = (row: ChangeRow): string =>
	row.kind === 'subject' ? row.subject.name : `${row.rules.map((rule) => rule.rule).join('+')} ×${row.subjects.length}`

describe('the approval view', () => {
	const view = approvalView(intake)

	test('keeps every line exactly once', () => {
		const shown = [...rowsOf(view).flatMap(rowChanges), ...view.unsorted]
		expect(shown).toHaveLength(intake.length)
		expect(new Set(shown)).toEqual(new Set(intake))
	})

	test('shows every widening and every closer review on a row of its own, in a group the page does not collapse', () => {
		for (const entry of [...view.callers, ...view.data]) {
			for (const row of entry.rows) {
				if (row.kind === 'folded') expect(rowChanges(row).every((change) => change.effect !== 'widens' && change.review !== 'closer')).toBe(true)
			}
			expect(entry.collapsed).toBe(!entry.rows.flatMap(rowChanges).some((change) => change.effect === 'widens'))
		}
		const inView = [...view.callers, ...view.data].filter((entry) => !entry.collapsed).flatMap((entry) =>
			entry.rows.flatMap((row) => (row.kind === 'subject' ? row.changes : []))
		)
		expect(intake.filter((change) => change.effect === 'widens').every((change) => inView.includes(change))).toBe(true)
	})

	test('groups endpoints by who reaches them, a closer review first, and each link mount apart', () => {
		expect(view.callers.map((entry) => entry.key)).toEqual(['anyone', 'link:student', 'human'])
		expect(view.impact).toEqual({
			callers: [
				{ key: 'anyone', reach: 'anyone', endpoints: 5, mounts: 0 },
				{ key: 'link:student', reach: 'link', mount: 'student', endpoints: 1, mounts: 0 },
				{ key: 'human', reach: 'human', endpoints: 41, mounts: 0 },
			],
			// The added file counts; the removed one runs nowhere.
			migrations: 1,
		})
		expect(view.data.map((entry) => entry.key)).toEqual(['migration', 'table'])
		expect(view.data.find((entry) => entry.key === 'table')?.collapsed).toBe(true)
	})

	test("keeps each endpoint's lines on its row, its widening first", () => {
		const register = view.callers[0]?.rows.find((row) => row.kind === 'subject' && row.subject.name === 'register')
		expect(register?.kind === 'subject' && register.changes.map((change) => change.rule)).toEqual(['endpoint.added', 'reach.kicks'])
	})

	test('folds quiet endpoints that changed alike, after the widening that leads the group, and keeps a pair apart', () => {
		expect(view.callers.find((entry) => entry.key === 'human')?.rows.map(label)).toEqual([
			'staff.files.remove',
			'procedure.admission+endpoint.body-limit ×3',
			'endpoint.body-limit ×37',
		])
		const pair = approvalView(intake.filter((change) => change.rule !== 'endpoint.body-limit' && change.subject?.name !== 'staff.e02'))
		expect(rowsOf(pair).every((row) => row.kind === 'subject')).toBe(true)
	})

	test('places a removed mount whose paths now reach a public endpoint with anyone, and counts it as a mount', () => {
		const removal: AccessChangeDto = {
			effect: 'widens',
			line: 'Mount `admin` is removed: GET /admin/* now reaches `site` for anyone, where it was for human callers who are members',
			rule: 'mount.removed',
			subject: { kind: 'mount', name: 'admin' },
			audience: anyone,
		}
		const removed = approvalView([removal, ...intake])
		expect(removed.callers[0]?.rows.map(label)).toContain('admin')
		expect(removed.impact.callers[0]).toEqual({ key: 'anyone', reach: 'anyone', endpoints: 5, mounts: 1 })
		expect(removed.data.some((entry) => entry.key === 'mount')).toBe(false)
	})

	test('puts lines stored before lines carried facts apart, in their order', () => {
		const stored: AccessChangeDto[] = [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }, {
			effect: 'narrows',
			line: 'Mount `old` is removed',
		}]
		expect(approvalView(stored)).toEqual({ impact: { callers: [], migrations: 0 }, callers: [], data: [], unsorted: stored })
	})
})
