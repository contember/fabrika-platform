// The approval page (ADR-0050 §7): who gains access first, a group that only narrows starts closed, a closer review says
// why, quiet endpoints that changed alike fold into one row, and a run says where it stands.

import { approvalView } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalStage } from '../lib/access-changes'
import type { AccessChangeDto, ApprovalDto, ChangeAudienceDto, RunDto } from '../lib/api'
import { AccessChangeView } from '../routes/approvals/detail'

const anyone: ChangeAudienceDto = { reach: 'anyone', requirement: null }
const staff: ChangeAudienceDto = { reach: 'human', requirement: 'with `candidates.read` (on `candidate`)' }

function endpoint(
	name: string,
	audience: ChangeAudienceDto,
	line: string,
	fact: Partial<AccessChangeDto> & Pick<AccessChangeDto, 'effect' | 'rule'>,
): AccessChangeDto {
	return { line, subject: { kind: 'endpoint', name, method: 'POST', path: `/${name}` }, audience, ...fact }
}

const CHANGES: AccessChangeDto[] = [
	endpoint('register', anyone, 'New endpoint `register` (POST /register) for anyone, without signing in', {
		effect: 'widens',
		rule: 'endpoint.added',
		review: 'closer',
		reason: 'anyone-calls',
	}),
	endpoint('register', anyone, 'Endpoint `register` starts job `intake` whenever anyone calls it', {
		effect: 'widens',
		rule: 'reach.kicks',
		review: 'closer',
		reason: 'anyone-calls',
		consequence: { kind: 'starts-job', job: 'intake' },
	}),
	...['a', 'b', 'c', 'd'].map((name) =>
		endpoint(`staff.${name}`, staff, `Endpoint \`staff.${name}\` body limit changes from none to 65536 bytes`, {
			effect: 'narrows',
			rule: 'endpoint.body-limit',
		})
	),
]

const RUN: RunDto = {
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
}

const APPROVAL: ApprovalDto = {
	run: RUN,
	outcome: 'widening',
	changes: CHANGES,
	candidateDigest: `sha256:${'a'.repeat(64)}`,
	baselineDigest: `sha256:${'b'.repeat(64)}`,
	baselineRunId: null,
	protected: true,
	endpoints: [
		{
			id: 'register',
			method: 'POST',
			path: '/register',
			kind: 'public',
			reach: 'anyone',
			callers: [],
			requirement: null,
			notes: ['at most 10 calls a minute per client', 'turnstile challenge'],
		},
	],
	approval: null,
}

const render = (approval: ApprovalDto) => renderToStaticMarkup(createElement(AccessChangeView, { view: approvalView(approval.changes), approval }))

describe('the approval page', () => {
	const markup = render(APPROVAL)

	test('opens the group anyone reaches, with what stands in front of each endpoint, and keeps a narrowing-only group closed', () => {
		expect(markup).toContain('<details class="card change-group" open="">')
		expect(markup).toContain('Anyone, without signing in')
		expect(markup).toContain('at most 10 calls a minute per client · turnstile challenge')
		expect(markup.match(/<details class="card change-group">/g)).toHaveLength(1)
	})

	test('says why a line needs closer review, naming the job anyone sets off', () => {
		expect(markup).toContain('Anyone on the internet decides when job <code>intake</code> runs.')
		expect(markup).toContain('Anyone on the internet sets this off, without signing in.')
	})

	test('folds four endpoints that only narrow alike into one row', () => {
		expect(markup).toContain('<strong>4</strong> endpoints that only narrow access, alike: <code>endpoint.body-limit</code>')
	})

	test("does not show an endpoint's protection on a removed mount of the same name", () => {
		const mount: AccessChangeDto = {
			effect: 'widens',
			line: 'Mount `register` is removed: GET /register/* now reaches `site` for anyone',
			rule: 'mount.removed',
			subject: { kind: 'mount', name: 'register' },
			audience: anyone,
		}
		const removed = render({ ...APPROVAL, changes: [mount] })
		expect(removed).not.toContain('at most 10 calls a minute per client')
		expect(removed).toContain('<span class="muted">removed</span>')
	})

	test('shows the lines of a run classified before lines carried facts in their effect sections', () => {
		const stored = render({ ...APPROVAL, changes: [{ effect: 'widens', line: 'Role `editor` gains `notes.delete`' }] })
		expect(stored).toContain('Widens access')
		expect(stored).not.toContain('change-group')
	})
})

describe('where a run stands', () => {
	const approved = { principalId: 'p-ada', label: 'ada@example.test', approvedAt: 2, holds: true }

	test('waiting, approved and queued, published, and an approval that lapsed', () => {
		expect(approvalStage(APPROVAL).text).toBe('Waiting for a decision')
		expect(approvalStage({ ...APPROVAL, run: { ...RUN, status: 'pending' }, approval: approved }).text).toBe('Approved, waiting to run')
		expect(approvalStage({ ...APPROVAL, run: { ...RUN, status: 'succeeded' }, approval: approved })).toEqual({
			lamp: 'ok',
			text: 'Approved and published',
		})
		expect(approvalStage({ ...APPROVAL, approval: { ...approved, holds: false } }).lamp).toBe('stop')
	})

	test('refused, cancelled, and a run that never waited', () => {
		const stage = (run: Partial<RunDto>, rest: Partial<ApprovalDto> = {}) => approvalStage({ ...APPROVAL, ...rest, run: { ...RUN, ...run } }).text
		expect(stage({ status: 'failed' })).toBe('Refused')
		expect(stage({ status: 'failed', cancelRequestedAt: 3 })).toBe('Cancelled')
		expect(stage({ status: 'failed', cancelRequestedAt: 3 }, { approval: approved })).toBe('Approved, then cancelled')
		expect(stage({ status: 'succeeded', cancelRequestedAt: 3 })).toBe('Published before the cancellation took effect')
		expect(stage({ status: 'succeeded' }, { outcome: 'no-widening' })).toBe('Published without waiting for approval')
		expect(stage({ status: 'succeeded' }, { protected: false })).toBe('Published without waiting for approval')
		expect(stage({ status: 'failed' }, { protected: false })).toBe('Failed without waiting for approval')
	})
})
