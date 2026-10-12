// Forms that kick a job (WU15b): `signup` and `apply` start a run of `welcome` once their row committed; `notify` is
// the same kind of form without `then`, whose answer the others must match.

import { app } from './src/app-kit'
import { Application, Notice, Signup } from './src/schemas'
import { welcome } from './src/welcome'

export const contract = app.contract((c) => ({
	signup: c.form('/signup', { input: Signup, appendTo: 'signups', honeypot: 'website', rate: { perClient: 100 }, then: 'welcome' }),
	apply: c.form('/apply', {
		input: Application,
		appendTo: 'applications',
		challenge: { provider: 'turnstile', secret: 'TURNSTILE_SECRET' },
		rate: { perClient: 2 },
		then: 'welcome',
	}),
	notify: c.form('/notify', { input: Notice, appendTo: 'notices' }),
	jobs: { welcome },
}))
