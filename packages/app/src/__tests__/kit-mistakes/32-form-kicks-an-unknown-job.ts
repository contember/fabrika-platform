import { app } from '../fixtures/visitor-intake/src/app-kit'
import { intake } from '../fixtures/visitor-intake/src/intake/endpoints'
import { Register } from '../fixtures/visitor-intake/src/schemas'

export const contract = app.contract((c) => ({
	// mistake: a form kicks a job of the contract's jobs section, and this one names a job it does not declare
	register: c.form('/register', { input: Register, appendTo: 'registrations', then: 'intak' }),
	jobs: { intake },
}))
