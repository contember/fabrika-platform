import { z } from 'zod/v4'
import { app } from '../kit-fixture/src/app-kit'
import { close } from '../kit-fixture/src/jobs'

const Lead = z.strictObject({ email: z.email() })

export const contract = app.contract((c) => ({
	// mistake: a form kicks a job of the contract's jobs section, and this one names a job it does not declare
	leads: c.form('/leads', { input: Lead, appendTo: 'leads', then: 'clsoe' }),
	jobs: { close },
}))
