// A public intake: a registration form with a honeypot and a Turnstile challenge, and a plain contact form. Each
// declares its own rate, small enough for a test to empty its buckets.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

export const Application = z.strictObject({
	name: z.string().min(1),
	email: z.email(),
	website: z.optional(z.string()),
	challengeToken: z.string(),
})
export const Contact = z.strictObject({ email: z.email(), body: z.string().min(1) })

export const contract = defineContract(vocabulary, (c) => ({
	apply: c.form('/apply', {
		input: Application,
		appendTo: 'applications',
		honeypot: 'website',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		rate: { perClient: 3, perForm: 5 },
	}),
	contact: c.form('/contact', { input: Contact, appendTo: 'messages', rate: { perClient: 2, perForm: 4 } }),
	health: c.health('/healthz'),
}))
