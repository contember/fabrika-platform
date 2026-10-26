import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Ids = z.strictObject({ ids: z.array(z.string()) })
const Id = z.strictObject({ id: z.string() })

export const review = app.group({ callers: ['human'] }, (r) => ({
	reasons: r.query({ output: Ids, access: { action: 'candidates.read', over: 'candidate' }, sql: 'read' })
		.handle(async ({ ctx }) => ({
			ids: (await ctx.sql(Id)`select r.id from reasons r where ${
				// mistake: a scoped site reads reasons with their read action, candidates.review
				ctx.sql.scope(ctx.within, 'reasons', { alias: 'r' })}`).map((row) => row.id),
		})),
}))
