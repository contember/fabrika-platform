// A contract served over `@fabrika/db` on Postgres: every access form reaches the notes table through the scoped
// stores. `keep` and `reuse` are the "performance" edit the data layer must refuse: a Ref cached across requests.

import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { vocabulary } from './src/vocabulary'

export const Note = z.strictObject({ id: z.uuid(), title: z.string() })
export const NoteList = z.strictObject({ items: z.array(Note) })
export const ById = z.strictObject({ id: z.uuid() })
export const NewNote = z.strictObject({ workspaceId: z.string(), title: z.string().min(1) })
export const Created = z.strictObject({ id: z.uuid() })
export const Kept = z.strictObject({ kept: z.boolean() })

export const contract = defineContract(vocabulary, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		notes: {
			list: c.query({ output: NoteList, access: { action: 'notes.read', over: 'workspace' } }),
			get: c.query({ input: ById, output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			create: c.mutation({ input: NewNote, output: Created, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
			keep: c.query({ input: ById, output: Kept, access: { action: 'notes.read', on: 'note', from: 'id' } }),
			reuse: c.query({ output: Note, access: { member: true } }),
		},
	}),
	health: c.health('/healthz'),
}))
