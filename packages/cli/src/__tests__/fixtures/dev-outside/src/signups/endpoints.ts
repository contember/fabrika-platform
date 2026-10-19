import { z } from 'zod/v4'
import { app } from '../app-kit'
import { mailer } from '../mail'

const Requested = z.strictObject({ email: z.string() })

export const welcome = app.cron('0 * * * *', {
	actions: ['signups.process'],
	scope: 'app',
	retries: 0,
	sql: 'read',
	egress: ['https://outbox.invalid'],
})
	.handle(async ({ ctx }) => {
		const rows = await ctx.transaction((tx) => tx.sql(Requested)`select email from requests order by email`)
		for (const row of rows) await mailer.get().send(row.email, ctx.signal)
	})

export const broken = app.cron('0 3 * * *', { actions: ['signups.process'], scope: 'app', retries: 0 }).handle(() => {
	throw new Error('the broken job threw on purpose')
})

let receipts = 0

/** Each run hands one receipt to the mail stand-in under the next key: `receipt-1`, `receipt-2`, … */
export const receipt = app.cron('30 * * * *', { actions: ['signups.process'], scope: 'app', retries: 0, mailer: 'installation' })
	.handle(async ({ ctx }) => {
		receipts += 1
		await ctx.mail.send({
			to: 'payer@receipt.example',
			subject: `Receipt ${receipts}`,
			text: 'Paid in full.',
			html: "<p>Paid</p><script>document.title = 'the receipt ran a script'</script>",
			idempotencyKey: `receipt-${receipts}`,
		})
	})
