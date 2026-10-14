import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Names = z.strictObject({ names: z.array(z.string()) })

export const operations = app.group({ callers: ['human'] }, (r) => ({
	names: r.query({ output: Names, access: { action: 'candidates.count', app: true } })
		.handle(async ({ ctx }) => ({
			// mistake: candidates.count is in the candidates' appCount, which counts and reads no row
			names: (await ctx.db.app.candidates.list()).items.map((row) => row.name),
		})),
}))
