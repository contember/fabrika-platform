import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({
	app: 'notes',
	// mistake: a language IAM does not speak
	locale: 'de',
	dimensions: { workspace: {} },
	actions: { 'notes.read': 'Read notes' },
	roles: { reader: { grants: ['notes.read'] } },
}, (c) => ({ health: c.health('/healthz') }))
