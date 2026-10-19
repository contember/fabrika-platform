import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const options = {
	kind: 'form',
	path: '/contact',
	scheme: 'github-sha256',
	boundTo: 'app',
	actions: ['notes.write'],
	input: z.strictObject({ message: z.string() }),
} as const

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: {} },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Create and edit notes' },
	roles: { editor: { grants: ['notes.read', 'notes.write'] } },
}, (c) => ({
	// mistake: an options const that sets the builder's kind and path
	github: c.webhook('/hooks/github', options),
}))
