import type { Ref, Within } from '@fabrika/db'
import { database } from '../database'

export const organizations = database.defineStore('organizations', (t) => ({
	get: (organization: Ref<'organization', 'organizations.read'>) => t.get(organization),
}))

export const workspaces = database.defineStore('workspaces', (t) => ({
	list: (within: Within<'organization', 'workspaces.read'>) => t.select(within, (q) => q.columns(['id', 'name']).orderBy('id')),
}))

export const notes = database.defineStore('notes', (t) => ({
	get: (note: Ref<'note', 'notes.read'>) => t.get(note),
	list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
	count: (within: Within<'workspace', 'notes.read'>) => t.aggregate(within, { count: true }),
	create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title, pinned: false }),
	rename: (note: Ref<'note', 'notes.write'>, title: string, expect: number) => t.update(note, { title }, { expectVersion: expect }),
}))

export const comments = database.defineChildStore('note_comments', (t) => ({
	list: (note: Ref<'note', 'notes.read'>) => t.select(note, (q) => q.columns(['id', 'body']).orderBy('id')),
}))
