// A contract with jobs over `@fabrika/db`: `purge` and `sweep` delete expired notes in every workspace, `flaky` only
// reads. The notes table and its migration are the scoped-notes fixture's.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
export const NoteList = z.strictObject({ items: z.array(Note) })

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: { members: { manage: 'notes.admin', list: 'notes.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.admin': 'Manage the workspace and its members',
	},
	roles: {
		owner: {
			grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: { list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }) },
	}),
	health: c.health('/healthz'),
	jobs: {
		purge: c.cron('0 3 * * *', { actions: ['notes.read', 'notes.delete'], scope: 'app', timeout: '10m', retries: 2 }),
		sweep: c.cron('*/15 * * * *', { actions: ['notes.read', 'notes.delete'], scope: 'app', timeout: '1m' }),
		flaky: c.cron('0 * * * *', { actions: ['notes.read'], scope: 'app', retries: 1 }),
	},
}))
