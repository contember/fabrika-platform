import { z } from 'zod/v4'
import { app } from '../fixtures/visitor-intake/src/app-kit'

const Register = z.strictObject({ email: z.email(), fullName: z.string() })
const inbox: string = 'registrations'

export const contract = app.contract((c) => ({
	// mistake: an inbox named by a string could be any table, so the form names its inbox table as a literal
	register: c.form('/register', { input: Register, appendTo: inbox }),
}))
