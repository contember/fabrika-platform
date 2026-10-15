import { app } from '../kit-fixture/src/app-kit'
import { ById } from '../kit-fixture/src/schemas'

export const deals = app.group({ callers: ['human'] }, (r) => ({
	notify: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' } })
		.handle(async ({ ctx }) => {
			// mistake: an endpoint writes an outbox row and kicks a job that sends it; it sends no mail itself
			await ctx.mail.send({ to: 'ada@example.com', subject: 'Deal', text: 'Updated', idempotencyKey: 'deal-1' })
			return { id: ctx.target.value }
		}),
}))
