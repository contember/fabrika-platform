// The application `fabrika app dev`'s stand-ins for the outside are tested on: a public sign-up behind a Turnstile
// challenge, a job that mails each sign-up through the provider MAIL_API_URL names, a job that throws, and a job that
// sends a receipt through the installation's mail transport. Its variables come from dev/dev.env only; its seed signs
// up, runs the jobs and reads the dev outbox and the mail the jobs sent.

import { app } from './src/app-kit'
import { broken, receipt, signups, welcome } from './src/signups/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { signups }),
	jobs: { welcome, broken, receipt },
}))
