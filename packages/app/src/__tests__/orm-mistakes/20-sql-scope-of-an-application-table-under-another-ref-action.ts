import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const ById = z.strictObject({ id: z.uuid() })
const Ids = z.strictObject({ ids: z.array(z.string()) })
const Id = z.strictObject({ id: z.string() })

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	positions: r.query({ input: ById, output: Ids, access: { action: 'candidates.read', on: 'candidate', from: 'id' }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			ids: (await ctx.sql(Id)`select p.id from positions p where ${
				// mistake: a scoped site reads positions with their read action, positions.read
				ctx.sql.scope(ctx.target, 'positions', 'p')}`).map((row) => row.id),
		})),
}))
