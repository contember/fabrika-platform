// One application every file of the run boots its kit for: one dimension table, a write that kicks a job, a read, and
// a count of the calls its deps saw, which starts again with each boot.

import { defineApp } from '@fabrika/app/contract'
import { defineDeps, serve } from '@fabrika/app/implement'
import { scoped } from '@fabrika/db'
import { z } from 'zod/v4'
import { tables } from '../cloudflare-fixture/src/db/tables'
import { vocabulary } from '../cloudflare-fixture/src/vocabulary'

const app = defineApp(vocabulary, tables)

const deps = defineDeps(() => ({ calls: 0 }))

const settle = app.cron('0 3 * * *', { actions: ['notes.read'] }).handle(async () => {
	await Bun.sleep(20)
})

const InWorkspace = z.strictObject({ workspaceId: z.string().min(1) })

const notes = app.group({ callers: ['human'] }, (r) => ({
	create: r.mutation({
		input: z.strictObject({ workspaceId: z.string().min(1), title: z.string().min(1) }),
		output: z.strictObject({ id: z.uuid() }),
		access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		kicks: ['settle'],
	}).handle(async ({ input, ctx }) => {
		const { id } = await ctx.db.target.notes.insert({ title: input.title })
		ctx.kick('settle')
		return { id }
	}),
	titles: r.query({
		input: InWorkspace,
		output: z.strictObject({ titles: z.array(z.string()) }),
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
	})
		.handle(async ({ ctx }) => ({ titles: (await ctx.db.target.notes.list({ orderBy: [['title', 'asc']] })).items.map((note) => note.title) })),
	calls: r.query({
		input: InWorkspace,
		output: z.strictObject({ calls: z.number() }),
		access: { action: 'notes.read', in: 'workspace', from: 'workspaceId' },
	})
		.handle(() => {
			const world = deps.get()
			world.calls += 1
			return { calls: world.calls }
		}),
}))

export const contract = app.contract((c) => ({ api: c.rpc('/api', { notes }), health: c.health('/healthz'), jobs: { settle } }))

/** One implementation, so every file's kit takes the same data layer over. */
export const implementation = serve(contract, { database: scoped(tables), deps })
