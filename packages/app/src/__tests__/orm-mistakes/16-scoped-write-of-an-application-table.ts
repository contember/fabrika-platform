import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const ById = z.strictObject({ id: z.uuid() })
const Saved = z.strictObject({ id: z.uuid(), version: z.int() })

export const candidates = app.group({ callers: ['human'] }, (r) => ({
	reason: r.mutation({ input: ById, output: Saved, access: { action: 'candidates.review', on: 'candidate', from: 'id' } })
		.handle(async ({ ctx }) =>
			// mistake: a scoped site reads an application table and never writes it
			ctx.db.app.reasons.insert({ label: 'Other' })
		),
}))
