// Every function takes the capability its endpoint or job was handed, never a bare id: the data layer scopes each
// statement by it.

import type { Ref, Within } from '@fabrika/db'
import { database } from '../database'

export const notes = database.defineStore('notes', (t) => ({
	list: (within: Within<'workspace', 'notes.read'>) =>
		t.select(within, (q) => q.columns(['id', 'title', 'trashed', 'version']).orderBy('title').limit(200)),
	trashed: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id']).where('trashed', '=', true).limit(200)),
	get: (note: Ref<'note', 'notes.read'>) => t.get(note),
	create: (workspace: Ref<'workspace', 'notes.write'>, title: string) => t.insert(workspace, { title, trashed: false }),
	trash: (note: Ref<'note', 'notes.write'>, expectVersion: number) => t.update(note, { trashed: true }, { expectVersion }),
	remove: (note: Ref<'note', 'notes.delete'>) => t.remove(note),
}))
