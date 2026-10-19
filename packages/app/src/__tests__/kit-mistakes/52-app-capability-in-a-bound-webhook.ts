import { app } from '../kit-fixture/src/app-kit'
import { Push } from '../kit-fixture/src/schemas'

export const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push })
	.handle(async ({ input, ctx }) => {
		// mistake: a webhook bound to a dimension acts on its bound value, never application-wide
		await ctx.db.app('crm.write').companies.insert({ name: input.ref })
	})
