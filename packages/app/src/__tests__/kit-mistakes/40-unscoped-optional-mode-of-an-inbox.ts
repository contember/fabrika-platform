import { app } from '../fixtures/visitor-intake/src/app-kit'

const reach: { readonly registrations?: 'read' | 'write' } = { registrations: 'write' }

// mistake: an optional mode that admits 'write' may write, and only its form writes an inbox
export const drain = app.cron('* * * * *', { actions: ['candidates.process'], scope: 'app', unscoped: reach })
	.handle(async () => {})
