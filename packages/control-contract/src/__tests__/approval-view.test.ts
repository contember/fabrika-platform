// The approval page's view of a classification (ADR-0050 §7): it keeps every line, shows every widening without
// expanding anything, folds only quiet subjects that changed alike, and decides nothing.

import { describe, expect, test } from 'bun:test'
import { type ApprovalView, approvalView, type ChangeRow, rowChanges } from '../approval-view'
import {
	type AccessChangeDto,
	type ApprovalCategory,
	type ChangeAudienceDto,
	changeCategories,
	DEFAULT_APPROVAL_CATEGORIES,
	gate,
	policyFromCategories,
	REVIEW_REASONS,
} from '../index'

/** Whether a change waits under an earlier category list, through the gate that replaced the list's predicate. */
function waitsForApproval(changes: readonly AccessChangeDto[], categories: readonly ApprovalCategory[]): boolean {
	return gate({ lines: changes }, policyFromCategories(categories)).kind !== 'pass'
}

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
				{ key: 'anyone', reach: 'anyone', endpoints: 5, removedEndpoints: 0, removedMounts: 0 },
				{ key: 'link:student', reach: 'link', mount: 'student', endpoints: 1, removedEndpoints: 0, removedMounts: 0 },
				{ key: 'human', reach: 'human', endpoints: 41, removedEndpoints: 0, removedMounts: 0 },
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
		expect(removed.impact.callers[0]).toEqual({ key: 'anyone', reach: 'anyone', endpoints: 5, removedEndpoints: 0, removedMounts: 1 })
		expect(removed.data.some((entry) => entry.key === 'mount')).toBe(false)
	})

	test('counts a removed endpoint apart from the endpoints that change', () => {
		const gone = endpoint('staff.old', anyone, { effect: 'widens', rule: 'endpoint.removed' })
		const reach = endpoint('staff.old', anyone, { effect: 'narrows', rule: 'reach.sql' })
		expect(approvalView([gone, reach, ...intake]).impact.callers[0]).toEqual({
			key: 'anyone',
			reach: 'anyone',
			endpoints: 5,
			removedEndpoints: 1,
			removedMounts: 0,
		})
	})

	test('puts lines stored before lines carried facts apart, in their order', () => {
		const stored: AccessChangeDto[] = [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }, {
			effect: 'narrows',
			line: 'Mount `old` is removed',
		}]
		expect(approvalView(stored)).toEqual({
			summary: { added: 0, changed: 0, removed: 0, check: stored.slice(0, 1) },
			impact: { callers: [], migrations: 0 },
			callers: [],
			data: [],
			unsorted: stored,
		})
	})

	test('the summary counts endpoints by what happened to them and leads with every line for closer review', () => {
		const { summary } = approvalView(intake)
		// Five public procedures, two signed-in endpoints and a link upload are new; forty endpoints change.
		expect([summary.added, summary.changed, summary.removed]).toEqual([7, 40, 0])
		expect(summary.check.map((change) => `${change.subject?.name} ${change.rule}`)).toEqual([
			...['cta', 'interest', 'register', 'resend', 'unsubscribe'].map((name) => `${name} endpoint.added`),
			'register reach.kicks',
			'0002.sql migration.adopt',
		])
	})

	test('without a line for closer review, the summary names the new endpoint the most exposed callers reach', () => {
		const quiet = intake.filter((change) => change.review !== 'closer')
		expect(approvalView(quiet).summary.check.map((change) => change.subject?.name)).toEqual(['student.upload'])
		expect(approvalView(quiet.filter((change) => change.rule !== 'endpoint.added')).summary.check.map((change) => change.subject?.name)).toEqual([
			'0002.sql',
		])
		expect(approvalView(quiet.filter((change) => change.effect !== 'widens')).summary.check).toEqual([])
	})

	test('endpoints machines and signed-in people both reach form a group of their own, and a heading counts endpoints', () => {
		const both: ChangeAudienceDto = { reach: 'machine', requirement: 'with `documents.read` (on `document`)', callers: ['human', 'machine'] }
		const robots: ChangeAudienceDto = { reach: 'machine', requirement: 'with `documents.read` (on `document`)', callers: ['machine'] }
		const view = approvalView([
			endpoint('api.render', both, { effect: 'widens', rule: 'endpoint.added' }),
			endpoint('api.render', both, { effect: 'neutral', rule: 'procedure.admission' }),
			endpoint('api.get', both, { effect: 'widens', rule: 'endpoint.output' }),
			endpoint('api.sync', robots, { effect: 'narrows', rule: 'endpoint.body-limit' }),
		])
		expect(view.callers.map((group) => ({ key: group.key, people: group.kind === 'caller' ? group.people : undefined, standing: group.standing })))
			.toEqual([
				{ key: 'machine+human', people: true, standing: { subjects: 2, widening: 2, closer: 0 } },
				{ key: 'machine', people: undefined, standing: { subjects: 1, widening: 0, closer: 0 } },
			])
		expect(view.impact.callers.map((entry) => [entry.key, entry.people, entry.endpoints])).toEqual([['machine+human', true, 2], [
			'machine',
			undefined,
			1,
		]])
	})
})

// ADR-0083: a line's categories are facts the diff recorded; an environment waits for the categories it chose.
describe('approval categories', () => {
	const line = (change: Omit<AccessChangeDto, 'line'> & { rule: string }): AccessChangeDto => ({ line: change.rule, ...change })
	const cases: Array<[string, AccessChangeDto, ApprovalCategory[]]> = [
		['a closer-review line', line({ effect: 'widens', rule: 'migration.data', review: 'closer', reason: 'deletes-data' }), ['deletes-data']],
		['a closer-review line stored before reasons', line({ effect: 'widens', rule: 'sql', review: 'closer' }), [...REVIEW_REASONS]],
		['a role that gains an action', line({ effect: 'widens', rule: 'role.grants' }), ['role-actions']],
		['a role that gains an action through a relation', line({ effect: 'widens', rule: 'role.via' }), ['role-actions']],
		['a role opened to externals', line({ effect: 'widens', rule: 'role.external' }), ['role-external']],
		['a new role', line({ effect: 'widens', rule: 'role.added' }), ['role-added']],
		['an endpoint made public', line({ effect: 'widens', rule: 'endpoint.public' }), ['public']],
		['a new endpoint anyone opens', line({ effect: 'widens', rule: 'endpoint.added', audience: anyone }), ['public']],
		['a new signed-in endpoint', line({ effect: 'widens', rule: 'endpoint.added', audience: staff }), []],
		['a CSP source added', line({ effect: 'widens', rule: 'csp.source' }), ['csp']],
		['a role that loses an action', line({ effect: 'narrows', rule: 'role.grants' }), []],
		['a CSP source removed', line({ effect: 'narrows', rule: 'csp.source' }), []],
	]

	for (const [name, change, categories] of cases) {
		test(`${name}: ${categories.join(', ') || 'no category'}`, () => {
			expect(changeCategories(change)).toEqual(categories)
		})
	}

	test('the defaults are the closer-review reasons, so a line without one never waits by default', () => {
		expect([...DEFAULT_APPROVAL_CATEGORIES]).toEqual([...REVIEW_REASONS])
		expect(waitsForApproval([line({ effect: 'widens', rule: 'role.grants' })], DEFAULT_APPROVAL_CATEGORIES)).toBe(false)
		expect(waitsForApproval([line({ effect: 'widens', rule: 'x', review: 'closer', reason: 'people' })], DEFAULT_APPROVAL_CATEGORIES)).toBe(true)
	})

	test('a line waits only for a chosen category', () => {
		const grows = [line({ effect: 'widens', rule: 'role.grants' })]
		expect(waitsForApproval(grows, ['role-actions'])).toBe(true)
		expect(waitsForApproval(grows, ['role-added', 'csp'])).toBe(false)
		const deletes = [line({ effect: 'widens', rule: 'm', review: 'closer', reason: 'deletes-data' })]
		expect(waitsForApproval(deletes, REVIEW_REASONS.filter((reason) => reason !== 'deletes-data'))).toBe(false)
		expect(waitsForApproval(deletes, [])).toBe(false)
	})
})
