import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Ids = z.strictObject({ ids: z.array(z.string()) })
const Id = z.strictObject({ id: z.string() })

export const admin = app.group({ callers: ['human'] }, (r) => ({
	positions: r.query({ output: Ids, access: { action: 'candidates.read', app: true }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			ids: (await ctx.sql(Id)`select p.id from positions p where ${
				// mistake: positions does not name candidates.read, so no fragment of it reaches the table
				ctx.sql.scope(ctx.app, 'positions', { alias: 'p' })}`).map((row) => row.id),
		})),
}))
