import { z } from 'zod/v4'
import { app } from '../fixtures/visitor-intake/src/app-kit'

const Register = z.strictObject({ email: z.email(), fullName: z.string(), website: z.optional(z.string()) })

export const contract = app.contract((c) => ({
	// mistake: a form's input field is its inbox column by name, and fullName is no column of registrations
	register: c.form('/register', { input: Register, appendTo: 'registrations', honeypot: 'website' }),
}))
