import { z } from 'zod/v4'
import { app } from '../../fixtures/visitor-intake/src/app-kit'

const Register = z.strictObject({ email: z.email(), name: z.string(), website: z.optional(z.string()) })

/** The same form with the honeypot named as a literal: only the hidden field is exempt, and it compiles. */
export const contract = app.contract((c) => ({
	register: c.form('/register', { input: Register, appendTo: 'registrations', honeypot: 'website' }),
}))
