// A multi-tenant contract: workspaces IAM creates, members a manager invites, share links of a note, and a GitHub
// webhook bound to a workspace. The IAM operations A13 serves. Only a staged kit's mutation binds a webhook, so
// `src/github.ts` serves the same webhook beside the procedures that bind it.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

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
export const Push = z.strictObject({
	ref: z.string(),
	repository: z.strictObject({ id: z.int(), full_name: z.string() }),
	head_commit: z.nullable(z.strictObject({ message: z.string() })),
})

export const contract = defineContract(vocabulary, (c) => ({
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
	github: c.webhook('/hooks/github', { scheme: 'github-sha256', boundTo: 'workspace', actions: ['notes.write'], input: Push }),
	health: c.health('/healthz'),
}))
