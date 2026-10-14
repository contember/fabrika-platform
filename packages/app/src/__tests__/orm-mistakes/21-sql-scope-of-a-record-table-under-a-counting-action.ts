import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Count = z.strictObject({ count: z.int() })
const Counted = z.strictObject({ count: z.int() })

export const operations = app.group({ callers: ['human'] }, (r) => ({
	candidates: r.query({ output: Count, access: { action: 'candidates.count', app: true }, sql: 'read' })
		.handle(async ({ ctx }) => {
			const [row] = await ctx.sql(Counted)`select count(*)::int as count from candidates c where ${
				// mistake: candidates.count only counts candidates through ctx.db.app; a fragment reads rows
				ctx.sql.scope(ctx.app, 'candidates', 'c')}`
			return { count: row?.count ?? 0 }
		}),
}))
