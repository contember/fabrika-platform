import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Count = z.strictObject({ count: z.int() })

export const admin = app.group({ callers: ['human'] }, (r) => ({
	candidates: r.query({ output: Count, access: { action: 'positions.manage', app: true } })
		.handle(async ({ ctx }) => ({
			// mistake: positions.manage is not the read action of candidates
			count: await ctx.db.app.candidates.count(),
		})),
}))
