// The application the generated tests are written for: a top-level dimension table, two contained ones, a child table
// and a reference table, with a column read policy and a version column; endpoints of every access form, for a person
// and for a machine caller.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

export const ById = z.strictObject({ id: z.string() })
export const ByNote = z.strictObject({ noteId: z.string() })
export const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string().min(1) })
export const Rename = z.strictObject({ id: z.string(), title: z.string().min(1), expectVersion: z.int().positive() })
export const Note = z.strictObject({ id: z.string(), title: z.string() })
export const Notes = z.strictObject({ items: z.array(Note) })
export const Named = z.strictObject({ id: z.string(), name: z.string() })
export const NamedList = z.strictObject({ items: z.array(Named) })
export const Comments = z.strictObject({ items: z.array(z.strictObject({ id: z.string(), body: z.string() })) })
export const Count = z.strictObject({ count: z.string() })
export const Done = z.strictObject({ id: z.string() })

export const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		organizations: {
			get: c.query({ input: ById, output: Named, access: { action: 'organizations.read', on: 'organization', from: 'id' } }),
		},
		workspaces: {
			list: c.query({ output: NamedList, access: { action: 'workspaces.read', over: 'organization' } }),
		},
		notes: {
			get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			list: c.query({ output: Notes, access: { action: 'notes.read', over: 'workspace' } }),
			create: c.mutation({ input: NewNote, output: Done, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
			rename: c.mutation({ input: Rename, output: Done, access: { action: 'notes.write', on: 'note', from: 'id' } }),
			comments: c.query({ input: ByNote, output: Comments, access: { action: 'notes.read', on: 'note', from: 'noteId' } }),
		},
	}),
	ops: c.rpc('/ops', { callers: ['machine'] }, {
		count: c.query({ output: Count, access: { action: 'notes.read', over: 'workspace' } }),
	}),
	health: c.health('/healthz'),
}))
