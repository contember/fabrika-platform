// The multi-tenant fixture's implementation. Each call makes its own `scoped(tables)`, because `boot` binds a layer
// once; `seen` records what the webhook handler received and can make its next run fail.

import { implement } from '@fabrika/app/implement'
import { type Ref, scoped } from '@fabrika/db'
import { contract } from '../fabrika.contract'
import { tables } from './db/tables'

export interface Seen {
	readonly pushes: unknown[]
	/** The delivery key of every run, in order. */
	readonly keys: string[]
	/** Make the next run fail after it wrote its note. */
	failNextPush: boolean
}

export function multiTenantApp(seen: Seen) {
	const database = scoped(tables)
	const notes = database.defineStore('notes', (t) => ({
		get: (note: Ref<'note', 'notes.read'>) => t.get(note),
		create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
	}))
	return implement(contract, {
		database,
		deps: () => notes,
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
			github: async ({ input, ctx }) => {
				seen.pushes.push(input)
				seen.keys.push(ctx.delivery.key)
				await notes.create(ctx.refs['notes.write'], input.head_commit?.message ?? input.ref)
				if (seen.failNextPush) {
					seen.failNextPush = false
					throw new Error('the handler failed after its write')
				}
			},
		}),
	})
}
