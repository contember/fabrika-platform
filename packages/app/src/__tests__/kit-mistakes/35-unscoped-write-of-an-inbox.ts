import { app } from '../fixtures/visitor-intake/src/app-kit'

// mistake: only its form appends to an inbox, and this job declares registrations unscoped: 'write'
export const drain = app.cron('* * * * *', { actions: ['candidates.process'], scope: 'app', unscoped: { registrations: 'write' } })
	.handle(async () => {})
