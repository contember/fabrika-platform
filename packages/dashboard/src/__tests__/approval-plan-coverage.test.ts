// A parked run's page reads only the lines no approved plan covers (ADR-0050 §5): Control says which ones it covers
// when the run is read, the change above leaves them out, and they stay one step away with the plans that cover them.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { approvalView, DEFAULT_APPROVAL_CATEGORIES } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { AccessChangeDto, ApprovalDto } from '../lib/api'
import { planCoverageSplit } from '../lib/approval-plans'
import { AccessChangeView, PlanAwareChange } from '../routes/approvals/detail'

const EDITOR: AccessChangeDto = {
	effect: 'widens',
	line: 'Role `editor` gains action `notes.delete`',
	rule: 'role.grants',
	subject: { kind: 'role', name: 'editor' },
}
const READER: AccessChangeDto = { effect: 'widens', line: 'Role `reader` is new', rule: 'role.added', subject: { kind: 'role', name: 'reader' } }
const TRIGGER: AccessChangeDto = {
	effect: 'widens',
	line: 'Migration `0002_titles.sql` declares trigger `notes.trim_title`',
	rule: 'migration.database-code',
	subject: { kind: 'migration', name: '0002_titles.sql' },
	review: 'closer',
	reason: 'off-road',
}
const PLAN_ID = '01a15abc-0000-7000-8000-0000000000c1'

const APPROVAL: ApprovalDto = {
	run: {
		id: '01a15abc-0000-7000-8000-000000000000',
		appId: 'intake',
		env: 'prod',
		ref: 'refs/heads/deploy/prod',
		commitSha: '8038f59'.padEnd(40, '0'),
		trigger: 'webhook',
		actor: null,
		status: 'awaiting_approval',
		exitCode: null,
		externalRunId: null,
		logKey: null,
		createdAt: 1,
		startedAt: null,
		finishedAt: null,
		cancelRequestedAt: null,
	},
	outcome: 'widening',
	changes: [EDITOR, READER, TRIGGER],
	candidateDigest: `sha256:${'a'.repeat(64)}`,
	baselineDigest: `sha256:${'b'.repeat(64)}`,
	baselineRunId: null,
	protected: true,
	categories: [...DEFAULT_APPROVAL_CATEGORIES],
	endpoints: [],
	approval: null,
	approvers: 1,
	requesterMayApprove: true,
	stepUp: 'none',
	planCoverage: { lines: [0, 2], plans: [PLAN_ID], publishes: false },
}

/** Render inside a router, as `Link` needs one. */
function render(element: ReactElement): string {
	const router = new Router({
		routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
		adapter: createMemoryNavigationAdapter(),
		pageRegistry: { 'approvals/plans/detail': '/approvals/plans/:id', 'apps/detail': '/apps/:id', 'runs/detail': '/runs/:id' },
	})
	return renderToStaticMarkup(createElement(BuzolaProvider, { router }, element))
}

const page = (approval: ApprovalDto) => render(createElement(PlanAwareChange, { approval }))

/** The markup before the covered section, and the section itself. */
function sections(markup: string): { readonly change: string; readonly covered: string } {
	const at = markup.indexOf('<h2>Covered by an approved plan</h2>')
	return at < 0 ? { change: markup, covered: '' } : { change: markup.slice(0, at), covered: markup.slice(at) }
}

describe('a parked run that an approved plan partly covers', () => {
	test('the split keeps the uncovered lines as the run and the covered ones apart, in order, on the same digests', () => {
		const { uncovered, covered } = planCoverageSplit(APPROVAL)
		expect(uncovered.changes).toEqual([READER])
		expect(covered).toEqual([EDITOR, TRIGGER])
		expect(uncovered.candidateDigest).toBe(APPROVAL.candidateDigest)
		expect(uncovered.baselineDigest).toBe(APPROVAL.baselineDigest)
	})

	test('the change reads only the uncovered lines and says how many more a plan covers; those sit folded under the plan', () => {
		const { change, covered } = sections(page(APPROVAL))
		expect(change).toContain('Role <code>reader</code> is new')
		expect(change).not.toContain('notes.delete')
		expect(change).not.toContain('trim_title')
		expect(change).toContain('Beside these, an approved plan covers 2 more lines')
		expect(covered).toContain(`href="/approvals/plans/${PLAN_ID}"`)
		expect(covered).toContain('these 2 lines, which the change above leaves out')
		expect(covered).toContain('Approving this run approves it whole and uses no plan.')
		expect(covered).toContain('<details class="every-line"><summary>Lines the plan covers')
		expect(covered).toContain('notes.delete')
		expect(covered).toContain('trim_title')
		// Another line still waits under the policy now, so the page promises no publication.
		expect(covered).not.toContain('Nothing else waits')
		// The folded list is not a second section of its own.
		expect(covered.match(/<h2>/g)).toHaveLength(1)
	})

	test('when a plan covers every line, the page says so and why the run still waits, with no empty list', () => {
		const markup = page({ ...APPROVAL, planCoverage: { lines: [0, 1, 2], plans: [PLAN_ID], publishes: true } })
		expect(markup).toContain('An approved plan covers every line of this change.')
		expect(markup).toContain('so it waits for your approval')
		expect(markup).not.toContain('Every line of the change')
		expect(markup).toContain('covers every line of this change. Approving this run approves it whole and uses no plan.')
		expect(markup).toContain('Nothing else waits now: a new deploy of this commit would publish through the plan without a decision.')
	})

	test('several plans are named as plans', () => {
		const other = '01a15abc-0000-7000-8000-0000000000c0'
		const { covered } = sections(page({ ...APPROVAL, planCoverage: { lines: [0, 2], plans: [PLAN_ID, other], publishes: false } }))
		expect(covered).toContain('Approved plans (')
		expect(covered).toContain(`href="/approvals/plans/${other}"`)
		expect(covered).toContain('Lines the plans cover')
	})

	test('without coverage the run reads as before', () => {
		const { planCoverage: _, ...plain } = APPROVAL
		const split = planCoverageSplit(plain)
		expect(split.uncovered).toBe(plain)
		expect(split.covered).toEqual([])
		expect(page(plain)).toBe(render(createElement(AccessChangeView, { view: approvalView(plain.changes), approval: plain })))
	})
})
