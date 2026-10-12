import type { Ref, Within } from '@fabrika/db'
import { defineStore } from '@fabrika/db/testing'
import { database } from '../database'

export const notes = defineStore(database, 'notes', (t) => ({
	list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
	get: (note: Ref<'note', 'notes.read'>) => t.get(note),
	create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title }),
}))
