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
import { AccessChangeView, PlanCovered } from '../routes/approvals/detail'

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
	planCoverage: { lines: [0, 2], plans: [PLAN_ID] },
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

describe('a parked run that an approved plan partly covers', () => {
	test('the change reads only the uncovered lines; the covered ones are kept apart, in order', () => {
		const { uncovered, covered } = planCoverageSplit(APPROVAL)
		expect(uncovered.changes).toEqual([READER])
		expect(covered).toEqual([EDITOR, TRIGGER])
		// The digests the decision binds stay the run's.
		expect(uncovered.candidateDigest).toBe(APPROVAL.candidateDigest)
		const change = render(createElement(AccessChangeView, { view: approvalView(uncovered.changes), approval: uncovered }))
		expect(change).toContain('Role <code>reader</code> is new')
		expect(change).not.toContain('notes.delete')
		expect(change).not.toContain('trim_title')
	})

	test('the covered lines sit folded under the plans that cover them, and approving the run uses no plan', () => {
		const { covered } = planCoverageSplit(APPROVAL)
		const markup = render(createElement(PlanCovered, { changes: covered, plans: [PLAN_ID], othersWait: true, crossOrigins: undefined }))
		expect(markup).toContain('Covered by an approved plan')
		expect(markup).toContain(`href="/approvals/plans/${PLAN_ID}"`)
		expect(markup).toContain('these 2 lines')
		expect(markup).toContain('Approving this run approves it whole and uses no plan.')
		expect(markup).not.toContain('Nothing else in it waits')
		expect(markup).toContain('<details class="every-line">')
		expect(markup).toContain('notes.delete')
	})

	test('when nothing else waits, the page says a new deploy would publish through the plan', () => {
		const markup = render(createElement(PlanCovered, { changes: [EDITOR], plans: [PLAN_ID], othersWait: false, crossOrigins: undefined }))
		expect(markup).toContain('this line')
		expect(markup).toContain('a new deploy of this commit would publish through the plan without a decision')
	})

	test('without coverage the run reads as before', () => {
		const { planCoverage: _, ...plain } = APPROVAL
		const split = planCoverageSplit(plain)
		expect(split.uncovered).toBe(plain)
		expect(split.covered).toEqual([])
	})
})
