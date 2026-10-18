import { z } from 'zod/v4'
import { app } from '../fixtures/form-files/src/app-kit'

const Register = z.strictObject({ email: z.email(), name: z.string(), challengeToken: z.string() })
const challenge = { provider: 'turnstile', secret: 'TURNSTILE_SECRET' } as const

export const contract = app.contract((c) => ({
	// mistake: a form's file field is its inbox column by name, and selfie is no column of registrations
	register: c.form('/register', { input: Register, appendTo: 'registrations', challenge, files: { selfie: { collection: 'photos' } } }),
}))
