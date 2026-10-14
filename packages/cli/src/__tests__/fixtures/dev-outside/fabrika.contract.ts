// The application `fabrika app dev`'s stand-ins for the outside are tested on: a sign-up form behind a Turnstile
// challenge, a job that mails each sign-up through the provider MAIL_API_URL names, and a job that throws. Its
// variables come from dev/dev.env only; its seed submits the form, runs both jobs and reads the dev outbox.

import { app } from './src/app-kit'
import { Join } from './src/schemas'
import { broken, welcome } from './src/signups/endpoints'

export const contract = app.contract((c) => ({
	join: c.form('/join', {
		input: Join,
		appendTo: 'requests',
		maxBytes: 1024,
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
	}),
	jobs: { welcome, broken },
}))
