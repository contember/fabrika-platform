// The approval page (ADR-0050 §7): who gains access first, a group that only narrows starts closed, a closer review says
// why, quiet endpoints that changed alike fold into one row, and a run says where it stands.

import { approvalView, DEFAULT_APPROVAL_CATEGORIES } from '@fabrika/control-contract'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { approvalStage } from '../lib/access-changes'
import type { AccessChangeDto, ApprovalDto, ChangeAudienceDto, DeployRequestDto, RunDto, SurfaceNoteDto } from '../lib/api'
import { AccessChangeView, Decision, DeployRequestView } from '../routes/approvals/detail'

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
	categories: [...DEFAULT_APPROVAL_CATEGORIES],
	endpoints: [
		{
			id: 'register',
			method: 'POST',
			path: '/register',
			kind: 'public',
			reach: 'anyone',
			callers: [],
			requirement: null,
			notes: [
				'at most 10 calls a minute per client',
				'turnstile challenge',
				'waits at most 30 s for a body of at most 65536 bytes, then runs at most 10 s',
			],
			noteFacts: [
				{ topic: 'guards', text: 'at most 10 calls a minute per client' },
				{ topic: 'guards', text: 'turnstile challenge' },
				{ topic: 'limits', text: 'waits at most 30 s for a body of at most 65536 bytes, then runs at most 10 s', default: true },
			],
		},
	],
	approval: null,
	approvers: 1,
}

const render = (approval: ApprovalDto) => renderToStaticMarkup(createElement(AccessChangeView, { view: approvalView(approval.changes), approval }))

describe('the approval page', () => {
	const markup = render(APPROVAL)

	test('opens the group anyone reaches, with what stands in front of each endpoint, and keeps a narrowing-only group closed', () => {
		expect(markup).toContain('<details class="card change-group" open="">')
		expect(markup).toContain('Anyone, without signing in')
		expect(markup).toContain('<span>at most 10 calls a minute per client</span><span> · turnstile challenge</span>')
		expect(markup.match(/<details class="card change-group">/g)).toHaveLength(1)
	})

	test('leads with a plain summary: what changes, who reaches it, whether it waits, and what to check first and why', () => {
		const summary = markup.slice(markup.indexOf('change-summary'), markup.indexOf('Who gains access'))
		expect(summary).toContain('This change adds 1 endpoint and changes 4.')
		expect(summary).toContain('anyone without signing in (1), signed-in people (4)')
		expect(summary).toContain('It widens access, and a line needs approval on this environment, so it waits for your approval.')
		expect(summary).toContain('Check first')
		expect(summary).toContain('Anyone on the internet decides when job <code>intake</code> runs.')
	})

	test('a run an earlier release parked for a widening without a closer-review line still says it waits, or that it waited', () => {
		const quiet = CHANGES.filter((change) => change.review !== 'closer')
		const summary = (approval: ApprovalDto) => {
			const page = render(approval)
			return page.slice(page.indexOf('change-summary'), page.indexOf('Who gains access'))
		}
		expect(summary({ ...APPROVAL, outcome: 'widening', changes: quiet })).toContain('It widens access, so it waits for your approval.')
		const approved = { principalId: 'p-ada', label: 'ada@example.test', approvedAt: 2, holds: true }
		expect(summary({ ...APPROVAL, changes: quiet, run: { ...RUN, status: 'succeeded' }, approval: approved })).toContain(
			'It widens access, so it waited for approval.',
		)
		expect(summary({ ...APPROVAL, changes: quiet, run: { ...RUN, status: 'succeeded' } })).toContain(
			'It widens access, and nothing in it needs approval on this environment, so it publishes without waiting.',
		)
	})

	test('says the default limits once, and in a row only the limits of its own', () => {
		expect(markup).toContain('A row marked <em>default limits</em> waits at most 30 s for a body of at most 65536 bytes, then runs at most 10 s.')
		expect(markup).toContain('<span class="muted"> · default limits</span>')
		expect(markup.match(/waits at most 30 s/g)).toHaveLength(1)
	})

	test('a heading counts its endpoints and points to the ones for closer review', () => {
		expect(markup).toContain('1 endpoint, it widens access')
		expect(markup).toContain('4 endpoints, none widens access')
		expect(markup).toContain('1 endpoint needs closer review, below')
	})

	test('a row of machines and signed-in people says so, renders its requirement, and says no fact twice', () => {
		const both: ChangeAudienceDto = { reach: 'machine', requirement: 'with `documents.read` (on `document`)', callers: ['human', 'machine'] }
		const added = endpoint(
			'api.render',
			both,
			'New endpoint `api.render` (POST /api.render) for human, machine callers …, answering a stored file',
			{
				effect: 'widens',
				rule: 'endpoint.added',
				inRow: 'New endpoint, answering a stored file of kind `rendered`',
				states: ['answers-file'],
			},
		)
		const facts: SurfaceNoteDto[] = [
			{ topic: 'answers-file', text: 'answers a stored file of kind `rendered`' },
			{ topic: 'limits', text: 'waits at most 30 s for a body of at most 65536 bytes, then runs at most 10 s', default: true },
		]
		const page = render({
			...APPROVAL,
			changes: [added],
			endpoints: [{
				id: 'api.render',
				method: 'POST',
				path: '/api.render',
				kind: 'mutation',
				reach: 'machine',
				callers: ['human', 'machine'],
				requirement: 'with `documents.read` (on `document`)',
				notes: facts.map((note) => note.text),
				noteFacts: facts,
			}],
		})
		const group = page.slice(page.indexOf('change-group'))
		expect(group).toContain('Machines and signed-in people')
		expect(group).toContain('with <code>documents.read</code> (on <code>document</code>)')
		expect(group).toContain('New endpoint, answering a stored file of kind <code>rendered</code>')
		expect(group).not.toContain('answers a stored file')
		expect(group).toContain('<span class="muted">default limits</span>')
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

	test('a run a person refused, or that nobody decided before its deadline, says so whatever its lines', () => {
		const stage = (failureCause: 'rejected' | 'expired', rest: Partial<ApprovalDto> = {}) =>
			approvalStage({ ...APPROVAL, ...rest, run: { ...RUN, status: 'failed', failureCause } })
		expect(stage('rejected')).toEqual({ lamp: 'stop', text: 'Refused by a person' })
		expect(stage('rejected', { outcome: 'no-widening', changes: [] }).text).toBe('Refused by a person')
		expect(stage('expired')).toEqual({ lamp: 'stop', text: 'Expired: nobody decided before the deadline' })
		expect(stage('expired', { outcome: 'none', changes: [] }).text).toBe('Expired: nobody decided before the deadline')
	})

	test('a run a newer run superseded says so, approved or not', () => {
		const stage = (rest: Partial<ApprovalDto>) => approvalStage({ ...APPROVAL, ...rest, run: { ...RUN, status: 'failed' } })
		expect(stage({ approval: approved, supersededBy: 'run-2' })).toEqual({
			lamp: 'stop',
			text: 'Approved, then superseded: a newer run published first, so this one did not deploy',
		})
		expect(stage({ outcome: 'no-widening', supersededBy: 'run-2' }).text).toBe('Superseded: a newer run published first, so this one did not deploy')
	})
})

// ADR-0050 §4: a request an agent or a key made shows who asked, the commit and its message as the agent wrote it.
describe('a deploy request', () => {
	const REQUEST: DeployRequestDto = {
		principal: { id: 'p-ada', type: 'user', label: 'ada@example.test' },
		credential: 'oauth',
		clientId: 'https://agent.example.test/<i>client</i>.json',
		commitSha: 'c'.repeat(40),
		commitMessage: 'Approve me <script>alert(1)</script>\n\n<a href="https://evil.test">safe</a>',
		runningCommitSha: 'b'.repeat(40),
		compareUrl: `https://github.com/acme/notes/compare/${'b'.repeat(40)}...${'c'.repeat(40)}`,
	}
	const render = (request: DeployRequestDto, approval: Partial<ApprovalDto> = {}) =>
		renderToStaticMarkup(
			createElement(DeployRequestView, {
				request,
				approval: { ...APPROVAL, changes: [], deadline: 1_800_000_000, ...approval, run: { ...RUN, trigger: 'manual', commitSha: request.commitSha } },
			}),
		)

	test("the agent's text is escaped and marked as the agent's", () => {
		const markup = render(REQUEST)
		expect(markup).not.toContain('<script>')
		expect(markup).not.toContain('<a href="https://evil.test">')
		expect(markup).not.toContain('<i>client</i>')
		expect(markup).toContain(
			'<pre class="agent-text">Approve me &lt;script&gt;alert(1)&lt;/script&gt;\n\n&lt;a href=&quot;https://evil.test&quot;&gt;safe&lt;/a&gt;</pre>',
		)
		expect(markup).toContain('Commit message, written by the agent')
		expect(markup).toContain('title="Written by the agent, not by Fabrika">https://agent.example.test/&lt;i&gt;client&lt;/i&gt;.json</span>')
	})

	test('who asked, the commit beside what runs, a compare link, and the deadline', () => {
		const markup = render(REQUEST)
		expect(markup).toContain('<strong>ada@example.test</strong> asks through an agent to deploy <code>ccccccc</code>')
		expect(markup).toContain('which runs <code>bbbbbbb</code>')
		expect(markup).toContain(`<code>${'c'.repeat(40)}</code>`)
		expect(markup).toContain(`href="${REQUEST.compareUrl}" target="_blank" rel="noreferrer noopener">Compare with what runs now</a>`)
		expect(markup).toContain('the request expires and deploys nothing')

		const { clientId: _, ...withoutClient } = REQUEST
		const key = render({ ...withoutClient, credential: 'key', commitMessage: null, runningCommitSha: null, compareUrl: null })
		expect(key).toContain('asks with a key to deploy')
		expect(key).toContain('which runs nothing yet.')
		expect(key).not.toContain('agent-text')
		expect(key).not.toContain('Compare with')
	})
})

// ADR-0050 §4: the decision offers only what Control would accept. A run past its deadline answers 410 until the sweep
// fails it, and the first of two approvers cannot give the second approval.
describe('the decision', () => {
	const NOW = 1_800_000_000
	const render = (approval: Partial<ApprovalDto>, me: string | null = 'p-ada') =>
		renderToStaticMarkup(createElement(Decision, { approval: { ...APPROVAL, deadline: NOW + 60, ...approval }, me, now: NOW, onDone: () => {} }))

	test('a waiting run offers approve and refuse before its deadline', () => {
		const markup = render({})
		expect(markup).toContain('Approve and deploy')
		expect(markup).toContain('>Refuse</button>')
	})

	test('a run past its deadline offers neither, and says it expired', () => {
		for (const deadline of [NOW, NOW - 60]) {
			const markup = render({ deadline })
			expect(markup).not.toContain('Approve and deploy')
			expect(markup).not.toContain('>Refuse</button>')
			expect(markup).toContain('expired')
		}
	})

	test('the person who gave the first of two approvals waits for a second person, and may still refuse', () => {
		const partialApproval = { principalId: 'p-ada', label: 'ada@example.test', approvedAt: NOW - 600 }
		const mine = render({ approvers: 2, partialApproval })
		expect(mine).not.toContain('Approve and deploy')
		expect(mine).toContain('Waiting for a second person')
		expect(mine).toContain('>Refuse</button>')

		const other = render({ approvers: 2, partialApproval }, 'p-bob')
		expect(other).toContain('Approve and deploy')
		expect(other).not.toContain('Waiting for a second person')
		expect(render({ approvers: 2 })).toContain('Approve and deploy')
	})
})
