// A multi-tenant contract: workspaces IAM creates, members a manager invites, share links of a note, a contact form
// and a GitHub webhook bound to a workspace. The anonymous kinds and the IAM operations A13 serves.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

export const Ok = z.strictObject({ ok: z.boolean() })
export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
export const Created = z.strictObject({ workspace: z.string() })
export const InWorkspace = z.strictObject({ workspaceId: z.string() })
export const Invite = z.strictObject({ workspaceId: z.string(), email: z.email(), role: z.enum(['editor', 'owner']) })
export const Invited = z.strictObject({ invitationId: z.string() })
export const Remove = z.strictObject({ workspaceId: z.string(), principalId: z.string() })
export const MemberCount = z.strictObject({ members: z.int(), invitations: z.int() })
export const Share = z.strictObject({ id: z.uuid(), days: z.int() })
export const Shared = z.strictObject({ id: z.string(), url: z.string() })
export const Contact = z.strictObject({ email: z.email(), body: z.string().min(1) })
export const Push = z.strictObject({
	ref: z.string(),
	repository: z.strictObject({ id: z.int(), full_name: z.string() }),
	head_commit: z.nullable(z.strictObject({ message: z.string() })),
})

export const contract = defineContract({
	app: 'notes',
	dimensions: {
		workspace: { creator: 'owner', members: { manage: 'notes.admin', list: 'notes.read' } },
		note: { in: 'workspace' },
	},
	actions: {
		'notes.read': 'Read notes',
		'notes.write': 'Create and edit notes',
		'notes.share': 'Create share links for a note',
		'notes.admin': 'Manage the workspace and its members',
		'workspaces.create': 'Start a workspace',
		'contacts.read': 'Read contact messages',
	},
	roles: {
		starter: { grants: ['workspaces.create'] },
		support: { grants: ['contacts.read'] },
		editor: { grants: ['notes.read', 'notes.write', 'notes.share'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		owner: { grants: ['notes.read', 'notes.write', 'notes.share', 'notes.admin'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		workspaces: {
			create: c.mutation({ output: Created, access: { action: 'workspaces.create', creates: 'workspace' } }),
		},
		members: {
			invite: c.mutation({ input: Invite, output: Invited, access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' } }),
			remove: c.mutation({ input: Remove, output: Ok, access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' } }),
			count: c.query({ input: InWorkspace, output: MemberCount, access: { action: 'notes.admin', in: 'workspace', from: 'workspaceId' } }),
		},
		notes: {
			get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			share: c.mutation({ input: Share, output: Shared, access: { action: 'notes.share', on: 'note', from: 'id' } }),
		},
	}),
	shared: c.link('/s', {
		spa: 'dist/share',
		dimension: 'note',
		grants: ['notes.read'],
		issuedBy: 'notes.share',
		maxDays: 30,
		procedures: (l) => ({
			note: l.query({ output: Note, access: { action: 'notes.read' } }),
		}),
	}),
	contact: c.form('/contact', { input: Contact, appendTo: 'contact_messages', maxBytes: 512 }),
	github: c.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'workspace', actions: ['notes.write'], input: Push }),
	health: c.health('/healthz'),
}))
