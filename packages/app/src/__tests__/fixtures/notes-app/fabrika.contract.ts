// A notes contract with one of each companion. Compiled by `compile.test.ts`, which expects
// `@fabrika/auth-core`'s `notesArtifact` fixture, and checked by `@fabrika/check` in `check.test.ts`.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { ById, Contact, Deleted, Import, Imported, Me, NewWorkspace, Note, NoteList, Push } from './src/schemas'

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: {
			creator: 'owner',
			members: { manage: 'notes.admin', list: 'notes.read' },
		},
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.delete': 'Delete notes',
		'notes.share': 'Create share links for a note',
		'notes.admin': 'Manage the workspace and its members',
		'workspaces.create': 'Start a workspace',
		'contacts.read': 'Read contact messages',
	},
	roles: {
		starter: { grants: ['workspaces.create'] },
		support: { grants: ['contacts.read'] },
		editor: {
			grants: ['notes.read', 'notes.write', 'notes.share'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
		owner: {
			grants: ['notes.read', 'notes.write', 'notes.delete', 'notes.share', 'notes.admin'],
			member: { scope: 'workspace', assignableBy: ['owner'] },
		},
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		me: c.query({ output: Me, access: { member: true } }),
		notes: {
			list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
			remove: c.mutation({ input: ById, output: Deleted, access: { action: 'notes.delete', on: 'note', from: 'id' } }),
		},
		workspaces: {
			create: c.mutation({ input: NewWorkspace, output: ById, access: { action: 'workspaces.create', creates: 'workspace' } }),
		},
	}),
	machine: c.rpc('/machine', { callers: ['machine'] }, {
		importNotes: c.mutation({
			input: Import,
			output: Imported,
			access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' },
		}),
	}),
	shared: c.link('/s', {
		spa: 'dist/share',
		dimension: 'note',
		grants: ['notes.read'],
		issuedBy: 'notes.share',
		maxDays: 30,
		procedures: (l) => ({ note: l.query({ output: Note, access: { action: 'notes.read' } }) }),
	}),
	health: c.health('/healthz'),
	github: c.webhook('/hooks/github', {
		scheme: 'github-sha256',
		boundTo: 'workspace',
		actions: ['notes.write'],
		input: Push,
	}),
	contact: c.form('/contact', { input: Contact, appendTo: 'contact_messages' }),
	spa: c.spa('/', { dir: 'dist/app', access: { member: true } }),
	files: {
		attachments: c.files({
			owner: 'notes',
			read: 'notes.read',
			write: 'notes.write',
			delete: 'notes.write',
			maxBytes: 26214400,
			types: ['image/png', 'application/pdf'],
			maxPerOwner: 50,
		}),
	},
	jobs: {
		purgeDeleted: c.cron('0 3 * * *', { actions: ['notes.delete'], scope: 'app', timeout: '10m', retries: 2 }),
	},
	exports: {
		products: c.export({
			version: 1,
			consumers: ['shop'],
			audience: 'any consumer user',
			procedures: {
				get: c.query({ input: ById, output: z.nullable(Note), access: { action: 'notes.read', over: 'workspace' } }),
			},
		}),
	},
	imports: {
		catalog: {
			app: 'catalog',
			export: 'products',
			version: 1,
			digest: 'sha256:0000',
			procedures: ['get'],
			usedBy: ['api.notes.list'],
			timeoutMs: 3000,
		},
	},
	csp: { connectSrc: [{ origin: 'https://api.example.com', purpose: 'Maps tiles' }] },
}))
