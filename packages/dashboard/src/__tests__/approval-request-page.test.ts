// The approval request page (ADR-0083 §8): who asks and through what, the kind's description with the agent's text
// escaped and marked, and buttons only while a person can still decide.

import { buildRouteTree, createMemoryNavigationAdapter, Router } from '@buzola/router'
import { BuzolaProvider } from '@buzola/router/react'
import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ApprovalRequestDto } from '../lib/api'
import { ApprovalRequestView, RequestDecision, RequestOutcome } from '../routes/approvals/requests/detail'

const NOW = 1_800_000_000

const REQUEST: ApprovalRequestDto = {
	id: '01a15abc-0000-7000-8000-000000000001',
	kind: 'test.notes.put',
	category: 'secrets',
	appId: 'intake',
	env: 'prod',
	state: 'pending',
	url: 'https://console.example.test/approvals/requests/01a15abc-0000-7000-8000-000000000001',
	requester: {
		principal: { id: 'user-ana', type: 'user', label: 'Ana' },
		credential: 'oauth',
		clientId: 'https://agent.example.test/<b>client</b>',
		grantId: 'grant-1',
		personId: 'user-ana',
	},
	description: {
		summary: [{ text: 'Set the note ', agent: false }, { text: '<img src=x onerror=alert(1)>', agent: true }],
		facts: [{ label: 'Note', value: { text: '<script>bad()</script>', agent: true } }],
	},
	described: true,
	inputDigest: `sha256:${'a'.repeat(64)}`,
	approvers: 1,
	requesterMayApprove: true,
	stepUp: 'none',
	deadline: NOW + 3600,
	createdAt: NOW - 60,
	updatedAt: NOW - 60,
}

function view(request: ApprovalRequestDto): string {
	return renderToStaticMarkup(createElement(ApprovalRequestView, { request }))
}

function decision(request: ApprovalRequestDto, me: string | null): string {
	return renderToStaticMarkup(createElement(RequestDecision, { request, me, now: NOW, onDone: () => {} }))
}

describe('the approval request page', () => {
	test('the agent text is escaped and marked as the agent’s, Fabrika’s own words are not', () => {
		const html = view(REQUEST)
		expect(html).toContain('<strong>Ana</strong> asks through an agent')
		expect(html).toContain(
			'Set the note <span class="agent-text" title="Written by the agent, not by Fabrika">&lt;img src=x onerror=alert(1)&gt;</span>',
		)
		expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;')
		expect(html).toContain('&lt;b&gt;client&lt;/b&gt;')
		expect(html).not.toContain('<img')
		expect(html).not.toContain('<script')
		expect(html).toContain('<strong>intake</strong> · <strong>prod</strong>')
		expect(html).toContain('Decide by')
	})

	test('a key says so and names no agent', () => {
		const html = view({
			...REQUEST,
			requester: { principal: { id: 'svc-ci', type: 'service', label: 'ci' }, credential: 'key', personId: null },
		})
		expect(html).toContain('asks with a service key')
		expect(html).not.toContain('Agent <span')
	})

	test('a pending request offers both buttons to an approver', () => {
		const html = decision(REQUEST, 'user-bo')
		expect(html).toContain('>Approve</button>')
		expect(html).toContain('>Refuse</button>')
	})

	test('past the deadline there is no button', () => {
		const html = decision({ ...REQUEST, deadline: NOW }, 'user-bo')
		expect(html).not.toContain('<button')
		expect(html).toContain('expired')
	})

	test('the first of two approvers waits for a second person and may still refuse', () => {
		const html = decision({ ...REQUEST, approvers: 2, partialApproval: { principalId: 'user-bo', label: 'Bo', at: NOW - 10 } }, 'user-bo')
		expect(html).toContain('Waiting for a second person')
		expect(html).not.toContain('>Approve</button>')
		expect(html).toContain('>Refuse</button>')
	})

	test('a second person completes a two-person approval', () => {
		const html = decision({ ...REQUEST, approvers: 2, partialApproval: { principalId: 'user-bo', label: 'Bo', at: NOW - 10 } }, 'user-cy')
		expect(html).toContain('Bo approved it')
		expect(html).toContain('>Approve</button>')
	})

	test('a decision that takes a passkey says so before either button', () => {
		expect(decision({ ...REQUEST, stepUp: 'webauthn' }, 'user-bo')).toContain('Deciding this request takes one of your passkeys')
		expect(decision(REQUEST, 'user-bo')).not.toContain('passkey')
	})

	test('the requester’s own person may only refuse where the environment says so', () => {
		const html = decision({ ...REQUEST, requesterMayApprove: false }, 'user-ana')
		expect(html).not.toContain('>Approve</button>')
		expect(html).toContain('>Refuse</button>')
	})

	test('a request this Control cannot describe offers only Refuse, and says why', () => {
		const html = decision({ ...REQUEST, described: false }, 'user-bo')
		expect(html).not.toContain('>Approve</button>')
		expect(html).toContain('>Refuse</button>')
		expect(html).toContain('This Control cannot show what the request does, so it cannot be approved here.')
		expect(html).not.toContain('Approving carries it out')
	})

	test('an executed request shows its result, escaped', () => {
		const html = renderToStaticMarkup(
			createElement(RequestOutcome, {
				request: { ...REQUEST, state: 'executed', operationId: 'op-1', result: { note: '<i>x</i>' } },
			}),
		)
		expect(html).toContain('It was done.')
		expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
		expect(html).toContain('op-1')
	})

	test("an agent's grant shows the role with what it holds, as the approval pages summarize a role", () => {
		const html = view({
			...REQUEST,
			kind: 'iam.grants.create',
			category: 'agent-grants',
			description: {
				...REQUEST.description,
				role: {
					role: 'editor',
					scope: 'workspace',
					assignableBy: ['owner'],
					creatorOf: [],
					external: false,
					actions: ['notes.read', 'notes.write'],
					via: [{ relation: 'author', dimension: 'note', actions: ['notes.delete'], conferredBy: [] }],
				},
			},
		})
		expect(html).toContain('editor')
		expect(html).toContain('in each workspace, assigned by owner · 3 actions')
		expect(html).toContain('notes.read, notes.write')
		expect(html).toContain('notes.delete through author')
	})

	test("an agent's grant that IAM holds for a second administrator says so", () => {
		const router = new Router({
			routes: buildRouteTree([{ path: '/', component: () => null, isIndex: true }]),
			adapter: createMemoryNavigationAdapter(),
			pageRegistry: { approvals: '/approvals' },
		})
		const request: ApprovalRequestDto = {
			...REQUEST,
			kind: 'iam.grants.create',
			state: 'executed',
			result: { grantRequest: { id: 'gr-1', status: 'pending' } },
		}
		const html = renderToStaticMarkup(createElement(BuzolaProvider, { router }, createElement(RequestOutcome, { request })))
		expect(html).toContain('another administrator of the application approves it')
		expect(html).toContain('href="/approvals"')
	})

	test('a stale request says why it did not run', () => {
		const html = renderToStaticMarkup(
			createElement(RequestOutcome, { request: { ...REQUEST, state: 'stale', error: 'what the request acts on changed' } }),
		)
		expect(html).toContain('what the request acts on changed')
		expect(html).toContain('not carried out')
	})
})
