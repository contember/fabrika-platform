import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const ById = z.strictObject({ id: z.uuid() })
const Count = z.strictObject({ count: z.int() })

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	reasons: r.query({ input: ById, output: Count, access: { action: 'candidates.read', on: 'candidate', from: 'id' } })
		.handle(async ({ ctx }) => ({
			// mistake: a scoped site reads reasons only with their read action, candidates.review
			count: await ctx.db.app.reasons.count(),
		})),
}))
