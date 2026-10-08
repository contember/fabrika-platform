import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { CreateNote, Note } from './src/schemas/notes'

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' } as const,
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
		create: c.mutation({ input: CreateNote, output: Note, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
	}),
	health: c.health('/healthz'),
	jobs: { purgeDeleted: c.cron('0 3 * * *', { actions: ['notes.write'], scope: 'app' }) },
}))
