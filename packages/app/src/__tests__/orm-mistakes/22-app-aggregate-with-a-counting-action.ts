import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Groups = z.strictObject({ groups: z.int() })

export const operations = app.group({ callers: ['human'] }, (r) => ({
	groups: r.query({ output: Groups, access: { action: 'candidates.count', app: true } })
		.handle(async ({ ctx }) => ({
			// mistake: a group is a row value, so candidates.count, which only counts, has no aggregate
			groups: (await ctx.db.app.candidates.aggregate({ groupBy: ['id', 'name'], count: true })).length,
		})),
}))
