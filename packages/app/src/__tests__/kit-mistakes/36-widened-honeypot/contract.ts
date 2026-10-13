import { z } from 'zod/v4'
import { app } from '../../fixtures/visitor-intake/src/app-kit'

const Register = z.strictObject({ email: z.email(), fullName: z.string(), website: z.optional(z.string()) })
const options: { readonly input: typeof Register; readonly appendTo: 'registrations'; readonly honeypot: string } = {
	input: Register,
	appendTo: 'registrations',
	honeypot: 'website',
}

export const contract = app.contract((c) => ({
	// mistake: a honeypot typed string would exempt every field, so it names the hidden field as a literal
	register: c.form('/register', options),
}))
