import { app } from './app-kit'
import { Push } from './schemas'

export const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push })
	.handle(async ({ input, ctx }) => {
		await ctx.db.in(ctx.refs['crm.write']).companies.insert({ name: `${input.ref} ${ctx.delivery.key}` })
	})
