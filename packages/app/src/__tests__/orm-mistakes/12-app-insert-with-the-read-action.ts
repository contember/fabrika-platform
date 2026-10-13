import { z } from 'zod/v4'
import { app } from '../app-wide-fixture/src/app-kit'

const Title = z.strictObject({ title: z.string() })
const Saved = z.strictObject({ id: z.string(), version: z.int() })

export const positions = app.group({ callers: ['human'] }, (r) => ({
	add: r.mutation({ input: Title, output: Saved, access: { action: 'positions.read', app: true } })
		.handle(({ input, ctx }) =>
			// mistake: positions.read inserts no position
			ctx.db.app.positions.insert({ title: input.title })
		),
}))
