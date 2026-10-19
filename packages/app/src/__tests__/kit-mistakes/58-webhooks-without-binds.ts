import { WebhookSecret } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'

export const hooks = app.group({ callers: ['human'] }, (r) => ({
	connect: r.mutation({
		input: z.strictObject({ id: z.string() }),
		output: WebhookSecret,
		access: { action: 'members.manage', in: 'org', from: 'id' },
	})
		// mistake: a mutation writes a webhook's bindings only after it declares binds
		.handle(({ ctx }) => ctx.webhooks('github').bind(ctx.target, 'repository:42')),
}))
