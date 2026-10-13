import { z } from 'zod/v4'
import { app } from '../fixtures/visitor-intake/src/app-kit'

const Register = z.strictObject({ email: z.email(), name: z.string() })

export const contract = app.contract((c) => ({
	// mistake: a form appends to its inbox table, and candidates is a dimension table
	register: c.form('/register', { input: Register, appendTo: 'candidates' }),
}))
