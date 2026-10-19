import { WebhookSecret } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { app } from './app-kit'
import { Push } from './schemas'

export const github = app.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'org', actions: ['crm.write'], input: Push })
	.handle(async ({ input, ctx }) => {
		await ctx.db.in(ctx.refs['crm.write']).companies.insert({ name: `${input.ref} ${ctx.delivery.key}` })
	})

/** A provider that signs its body in a header of its own, with one binding for the whole application. */
export const ledger = app.webhook('/hooks/ledger', {
	scheme: { hmac: { header: 'X-Ledger-Signature', algorithm: 'sha256', encoding: 'base64', prefix: 'v1=', signed: 'body' } },
	boundTo: 'app',
	actions: ['crm.write'],
	input: Push,
}).handle(({ ctx }) => {
	ctx.app('crm.write')
})

/** The binding of the ledger, by a holder of the organization's member management held application-wide. */
export const ledgers = app.group({ callers: ['human'] }, (r) => ({
	connect: r.mutation({
		input: z.strictObject({ account: z.string() }),
		output: WebhookSecret,
		access: { action: 'members.manage', app: true },
		binds: 'ledger',
	}).handle(({ input, ctx }) => ctx.webhooks('ledger').bind(ctx.app, input.account)),
}))
