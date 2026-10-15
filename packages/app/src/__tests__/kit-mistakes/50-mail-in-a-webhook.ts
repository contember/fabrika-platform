import { app } from '../kit-fixture/src/app-kit'
import { Push } from '../kit-fixture/src/schemas'

export const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push })
	.handle(async ({ input, ctx }) => {
		// mistake: a webhook delivery writes an outbox row and kicks a job that sends it; it sends no mail itself
		await ctx.mail.send({ to: 'ada@example.com', subject: 'Pushed', text: input.ref, idempotencyKey: ctx.delivery.key })
	})
