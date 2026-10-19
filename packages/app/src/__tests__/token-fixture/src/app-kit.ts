import { defineApp, token } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const Recipient = z.strictObject({ email: z.email(), campaign: z.string().min(1).max(100) })
export const Booking = z.strictObject({ booking: z.uuid() })

export const app = defineApp(vocabulary, tables, {
	tokens: {
		unsubscribe: token(Recipient, { maxDays: 400 }),
		booking: token(Booking, { maxDays: 30 }),
	},
})
