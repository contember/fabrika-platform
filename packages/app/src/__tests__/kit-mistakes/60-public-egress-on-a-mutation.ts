import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	// mistake: a mutation calls out inside its transaction; egress: 'public' belongs on a cron job the mutation kicks
	touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, egress: 'public' })
		.handle(({ ctx }) => ({ id: ctx.target.value })),
}))
