// The approval plan page (ADR-0050 §5): what the plan lets through subject by subject, what still waits for a person,
// the agent's text escaped and marked, and buttons only while a person can still decide.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalPlansSection } from '../components/ApprovalPlansSection'
import type { AccessChangeDto, ApprovalPlanDto } from '../lib/api'
import { planLines } from '../lib/approval-plans'
import { PlanDecision, PlanRevoke, PlanView } from '../routes/approvals/plans/detail'

const NOW = 1_800_000_000

const TRIGGER: AccessChangeDto = {
	effect: 'widens',
	line: 'Migration `0002_titles.sql` declares trigger `notes.trim_title`',
	rule: 'migration.database-code',
	subject: { kind: 'migration', name: '0002_titles.sql' },
	review: 'closer',
}
const ROLE: AccessChangeDto = {
	effect: 'widens',
	line: 'Role `editor` is new',
	rule: 'role.added',
	subject: { kind: 'role', name: 'editor' },
}
const TABLE: AccessChangeDto = {
	effect: 'widens',
	line: 'New table policy `labels` read with `notes.read`',
	rule: 'table.added',
	subject: { kind: 'table', name: 'labels' },
}

const PLAN: ApprovalPlanDto = {
	id: '01a15abc-0000-7000-8000-000000000001',
	appId: 'intake',
	env: 'prod',
	commitSha: 'a'.repeat(40),
	state: 'pending',
	requester: {
		principal: { id: 'user-ana', type: 'user', label: 'Ana' },
		credential: 'oauth',
		clientId: 'https://agent.example.test/<b>client</b>',
		grantId: 'grant-1',
		personId: 'user-ana',
	},
	outcome: 'widening',
	lines: [{ change: TRIGGER, mode: 'plan', held: true }, { change: ROLE, mode: 'person', held: false }, { change: TABLE, mode: 'off', held: false }],
	candidateDigest: `sha256:${'c'.repeat(64)}`,
	baselineDigest: `sha256:${'b'.repeat(64)}`,
	baselineRunId: '01a15abc-0000-7000-8000-0000000000aa',
	approvers: 1,
	requesterMayApprove: true,
	stepUp: 'none',
	deadline: NOW + 3600,
	entries: [{ subject: 'migration:0002_titles.sql', state: 'pending' }],
	createdAt: NOW - 60,
}

/** Render inside a router, as `Link` needs one; it knows the pages the plan page links to. */
function render(element: ReactElement): string {
	const router = new Router({
		routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
		adapter: createMemoryNavigationAdapter(),
		pageRegistry: {
			'apps/detail': '/apps/:id',
			'runs/detail': '/runs/:id',
			'approvals/plans/detail': '/approvals/plans/:id',
		},
	})
	return renderToStaticMarkup(createElement(BuzolaProvider, { router }, element))
}

function decision(plan: ApprovalPlanDto, me: string | null): string {
	return render(createElement(PlanDecision, { plan, me, now: NOW, onDone: () => {} }))
}

describe('the approval plan page', () => {
	test('lines split by what they wait for: covered under their entry, a person, nothing', () => {
		const lines = planLines(PLAN)
		expect(lines.covered).toEqual([{ subject: 'migration:0002_titles.sql', entry: PLAN.entries[0], changes: [TRIGGER], mode: 'plan' }])
		expect(lines.person).toEqual([ROLE])
		expect(lines.off).toEqual([TABLE])
		// A `plan` line no entry holds waits for a person at the deploy.
		expect(planLines({ ...PLAN, lines: [{ change: TRIGGER, mode: 'plan', held: false }] }).person).toEqual([TRIGGER])
	})

	test('a held line stays under what the plan approves after the policy changed, and says what it waits for now', () => {
		const relaxed: ApprovalPlanDto = { ...PLAN, lines: [{ change: TRIGGER, mode: 'off', held: true }] }
		expect(planLines(relaxed).covered.map((subject) => subject.mode)).toEqual(['off'])
		expect(planLines(relaxed).off).toEqual([])
		const html = render(createElement(PlanView, { plan: relaxed, now: NOW }))
		expect(html).toContain('What the plan approves')
		expect(html).toContain('the plan lets them through if it asks for a plan again')
		const stricter = render(createElement(PlanView, { plan: { ...PLAN, lines: [{ change: TRIGGER, mode: 'person', held: true }] }, now: NOW }))
		expect(stricter).toContain('the plan does not let them through')
	})

	test('it shows what approving lets through, what still waits, and the agent text escaped and marked', () => {
		const html = render(createElement(PlanView, { plan: PLAN, now: NOW }))
		expect(html).toContain('<strong>Ana</strong> asks through an agent to approve the access change of')
		expect(html).toContain('on 1 subject without a second decision. 1 line still waits for a person at the deploy.')
		expect(html).toContain('<code>migration:0002_titles.sql</code>')
		expect(html).toContain('What the plan approves')
		expect(html).toContain('Still waits for a person at the deploy')
		expect(html).toContain('Lines that wait for nothing')
		expect(html).toContain('&lt;b&gt;client&lt;/b&gt;')
		expect(html).not.toContain('<b>client')
		expect(html).toContain('Decide by')
	})

	test('a consumed entry links the run it covered; an approved plan says until when it covers, while it covers', () => {
		const html = render(createElement(PlanView, {
			plan: {
				...PLAN,
				state: 'approved',
				expiresAt: NOW + 30 * 86_400,
				decision: { principalId: 'user-bo', label: 'Bo', at: NOW },
				entries: [{ subject: 'migration:0002_titles.sql', state: 'consumed', consumedByRunId: '01a15abc-0000-7000-8000-0000000000bb' }],
			},
			now: NOW,
		}))
		expect(html).toContain('used by')
		expect(html).toContain('run <code>01a15abc</code>')
		expect(html).toContain('it lets nothing more through')
		expect(html).not.toContain('Its entries cover a deploy until')
		expect(html).toContain('Approved by Bo')
		const active = render(createElement(PlanView, {
			plan: { ...PLAN, state: 'approved', expiresAt: NOW + 86_400, entries: [{ subject: 'migration:0002_titles.sql', state: 'active' }] },
			now: NOW,
		}))
		expect(active).toContain('Its entries cover a deploy until')
		expect(active).toContain('It lets a deploy of this change through on 1 subject')
	})

	test('a pending plan offers both buttons to an approver', () => {
		const html = decision(PLAN, 'user-bo')
		expect(html).toContain('>Approve plan</button>')
		expect(html).toContain('>Refuse</button>')
	})

	test('an expired plan has no button', () => {
		const html = decision({ ...PLAN, deadline: NOW }, 'user-bo')
		expect(html).not.toContain('<button')
		expect(html).toContain('so it expired and approves nothing')
	})

	test('the requester’s own person may only refuse where the environment says so; a key’s plan nobody approves', () => {
		const own = decision({ ...PLAN, requesterMayApprove: false }, 'user-ana')
		expect(own).not.toContain('>Approve plan</button>')
		expect(own).toContain('>Refuse</button>')
		const key = decision({
			...PLAN,
			requesterMayApprove: false,
			requester: { principal: { id: 'svc-ci', type: 'service', label: 'ci' }, credential: 'key', personId: null },
		}, 'user-bo')
		expect(key).toContain('A service key asked for this plan')
		expect(key).not.toContain('>Approve plan</button>')
	})

	test('the first of two approvers waits for a second person; a passkey is said before either button', () => {
		const first = decision({ ...PLAN, approvers: 2, partialApproval: { principalId: 'user-bo', label: 'Bo', at: NOW - 10 } }, 'user-bo')
		expect(first).toContain('Waiting for a second person')
		expect(first).not.toContain('>Approve plan</button>')
		expect(decision({ ...PLAN, stepUp: 'webauthn' }, 'user-bo')).toContain('Deciding this plan takes one of your passkeys')
	})

	test('an approved plan is revoked from its danger zone', () => {
		expect(render(createElement(PlanRevoke, { plan: { ...PLAN, state: 'approved' }, onDone: () => {} }))).toContain('>Revoke</button>')
	})

	test('the Approvals list links each plan and says until when it holds', () => {
		const html = render(createElement(ApprovalPlansSection, { plans: [PLAN] }))
		expect(html).toContain(`/approvals/plans/${PLAN.id}`)
		expect(html).toContain('1 subject · 3 widening')
		expect(html).toContain('Waiting for a decision')
	})
})
