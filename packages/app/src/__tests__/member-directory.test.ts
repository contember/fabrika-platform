// The read-only member directory (`ctx.members.list()`) of an endpoint whose action is its dimension's `members.list`,
// through the test kit's production proxy decision and a recording stand-in for IAM: the proxy admits only a caller
// holding that action on the target, the directory asks IAM about that target alone, and it hands out no email.

import { defineContract } from '@fabrika/app/contract'
import { implement } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import type { ListMembersInput, ListMembersResult } from '@fabrika/auth-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { RecordingMembership } from './fixtures/multi-tenant/iam'

const directory = defineContract({
	app: 'tasks',
	dimensions: { workspace: { creator: 'owner', members: { manage: 'tasks.admin', list: 'tasks.read' } } },
	actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks', 'tasks.admin': 'Manage the workspace' },
	roles: {
		owner: { grants: ['tasks.read', 'tasks.write', 'tasks.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		member: { grants: ['tasks.read', 'tasks.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		assignees: c.query({
			input: z.strictObject({ workspaceId: z.string() }),
			output: z.strictObject({ members: z.array(z.strictObject({ id: z.string(), label: z.nullable(z.string()) })) }),
			access: { action: 'tasks.read', in: 'workspace', from: 'workspaceId' },
		}),
	}),
}))

const app = implement(directory, {
	database: null,
	deps: () => null,
	handlers: () => ({
		api: {
			assignees: async ({ ctx }) => ({ members: (await ctx.members.list()).map((member) => ({ id: member.principalId, label: member.label })) }),
		},
	}),
})

/** IAM's answer to a `members.list` holder of a workspace whose owner also holds `members.manage` elsewhere. */
class DirectoryIam extends RecordingMembership {
	override async listMembers(input: ListMembersInput): Promise<ListMembersResult> {
		const recorded = await super.listMembers(input)
		if (!recorded.ok) {
			return recorded
		}
		return {
			ok: true,
			members: [
				{ principalId: 'user-1', label: 'Ann', email: 'ann@example.test', roles: ['owner'], disabled: false },
				{ principalId: 'user-2', label: 'Bob', email: null, roles: ['member'], disabled: true },
			],
			invitations: [{ id: 'inv-1', email: 'cyd@example.test', role: 'member', expiresAt: 1 }],
		}
	}
}

function post(body: unknown): RequestInit {
	return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

describe('ctx.members.list() on a members.list endpoint', () => {
	test('a member of the workspace lists its members: id and label, no email, no invitation', async () => {
		const membership = new DirectoryIam()
		const kit = testKit(app, { membership })
		const member = kit.testCaller([{ role: 'member', scope: { type: 'workspace', value: 'w1' } }])
		const response = await kit.browser(member)('/api/assignees', post({ workspaceId: 'w1' }))
		expect(await response.json()).toEqual({ result: { members: [{ id: 'user-1', label: 'Ann' }, { id: 'user-2', label: 'Bob' }] } })
		const [asked] = membership.calls
		expect(asked?.method).toBe('listMembers')
		expect(asked?.method === 'listMembers' ? asked.input.scope : null).toEqual({ type: 'workspace', value: 'w1' })
		expect(asked?.method === 'listMembers' ? asked.input.credential : null).toBeString()
		// Listing spends no membership authority, so the proxy obtains no delegation grant for it.
		expect(membership.delegations).toEqual([])
	})

	test('a member of another workspace is refused by the proxy, and IAM is not asked', async () => {
		const membership = new DirectoryIam()
		const kit = testKit(app, { membership })
		const outsider = kit.testCaller([{ role: 'member', scope: { type: 'workspace', value: 'w2' } }])
		const response = await kit.browser(outsider)('/api/assignees', post({ workspaceId: 'w1' }))
		expect(response.status).toBe(403)
		expect(membership.calls).toEqual([])
	})

	test("IAM's refusal of the caller is the caller's answer", async () => {
		const membership = new DirectoryIam()
		membership.refuse = { ok: false, reason: 'not_allowed' }
		const kit = testKit(app, { membership })
		const member = kit.testCaller([{ role: 'member', scope: { type: 'workspace', value: 'w1' } }])
		const response = await kit.browser(member)('/api/assignees', post({ workspaceId: 'w1' }))
		expect(response.status).toBe(403)
	})

	test('without an IAM membership transport the application boots, and only a list() call fails, with a 503', async () => {
		const kit = testKit(app)
		const member = kit.testCaller([{ role: 'member', scope: { type: 'workspace', value: 'w1' } }])
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const response = await kit.browser(member)('/api/assignees', post({ workspaceId: 'w1' }))
			expect(response.status).toBe(503)
		} finally {
			log.mockRestore()
		}
	})
})
