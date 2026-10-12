import { type Ref, scoped } from '@fabrika/db'
import { defineStore } from '@fabrika/db/testing'
import { implement } from '../../implement/implement'
import { contract } from '../fixtures/multi-tenant/fabrika.contract'
import { tables } from '../fixtures/multi-tenant/src/db/tables'

const database = scoped(tables)
const store = defineStore(database, 'notes', (t) => ({
	get: (note: Ref<'note', 'notes.read'>) => t.get(note),
	create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
}))

// a handler for a form, which appends to its inbox and runs no application code
const seen: { pushes: unknown[]; failNextPush: boolean } = { pushes: [], failNextPush: false }

export const app = implement(contract, {
	database,
	deps: () => store,
	handlers: (notes) => ({
		api: {
			workspaces: {
				create: ({ ctx }) => ({ workspace: ctx.created.value }),
			},
			members: {
				invite: async ({ input, ctx }) => {
					const result = await ctx.members.assign(ctx.target, { email: input.email }, input.role)
					return { invitationId: 'invited' in result ? result.invited.invitationId : result.assigned.principalId }
				},
				remove: async ({ input, ctx }) => {
					await ctx.members.revoke(ctx.target, { principalId: input.principalId })
					return { ok: true }
				},
				count: async ({ ctx }) => {
					const listed = await ctx.members.list(ctx.target)
					return { members: listed.members.length, invitations: listed.invitations.length }
				},
			},
			notes: {
				get: async ({ ctx }) => {
					const row = await notes.get(ctx.target)
					return { id: row.id, title: row.title }
				},
				share: async ({ input, ctx }) => {
					const link = await ctx.links.issue(ctx.target, { mount: 'shared', days: input.days })
					return { id: link.id, url: link.url }
				},
			},
		},
		shared: {
			note: async ({ ctx }) => {
				const row = await notes.get(ctx.target)
				return { id: row.id, title: row.title }
			},
		},
		// mistake: a form takes no handler
		contact: () => ({ received: true }),
		github: async ({ input, ctx }) => {
			seen.pushes.push(input)
			if (seen.failNextPush) {
				seen.failNextPush = false
				throw new Error('the handler failed')
			}
			await notes.create(ctx.refs['notes.write'], input.head_commit?.message ?? input.ref)
		},
	}),
})
