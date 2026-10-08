import type { Ref, Within } from '../../capability'
import { type DataLayerRuntime, scoped } from '../../store'
import { tables } from './tables'

export interface Page {
	readonly limit: number
	readonly offset: number
}

/** The application's stores, as `src/db/stores/*.ts` would define them. */
export function defineStores(runtime: DataLayerRuntime) {
	const { defineStore, defineChildStore } = scoped(tables, runtime)

	const organizations = defineStore('organizations', (t) => ({
		list: (within: Within<'organization', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'name']).orderBy('id')),
		create: (created: Ref<'organization', 'organizations.create'>, name: string) => t.insert(created, { name }),
	}))

	const workspaces = defineStore('workspaces', (t) => ({
		list: (within: Within<'organization', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'name']).orderBy('name')),
		get: (workspace: Ref<'workspace', 'notes.read'>) => t.get(workspace),
		create: (organization: Ref<'organization', 'workspaces.create'>, name: string) => t.insert(organization, { name }),
		rename: (workspace: Ref<'workspace', 'workspaces.admin'>, name: string) => t.update(workspace, { name }),
		move: (workspace: Ref<'workspace', 'workspaces.admin'>, to: Ref<'organization', 'workspaces.create'>) => t.move(workspace, to),
	}))

	const notes = defineStore('notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>, page: Page) =>
			t.select(within, (q) => q.columns(['id', 'title']).orderBy('id').limit(page.limit).offset(page.offset)),
		search: (within: Within<'workspace', 'notes.read'>, text: string) =>
			t.select(within, (q) => q.columns(['id', 'title']).whereAny([['title', 'contains', text], ['body', 'contains', text]]).orderBy('title').limit(50)),
		titled: (within: Within<'workspace', 'notes.read'>, text: string) => t.select(within, (q) => q.columns(['id', 'title']).contains('title', text)),
		latest: (within: Within<'workspace', 'notes.read'>, count: number) =>
			t.select(within, (q) => q.columns(['id', 'title', 'created_by']).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(count)),
		all: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.orderBy('id')),
		countPerWorkspace: (within: Within<'workspace', 'notes.read'>) => t.aggregate(within, { groupBy: ['workspace_id'], count: true }),
		words: (within: Within<'workspace', 'notes.read'>) =>
			t.aggregate(within, { count: true, sum: ['word_count'], min: ['word_count'], max: ['created_at'] }),
		withComments: (within: Within<'workspace', 'notes.read'>, ids: readonly string[]) =>
			t.select(within, (q) => q.columns(['id', 'title']).where('id', 'in', ids).join('note_comments', (c) => c.columns(['id', 'body'])).orderBy('id')),
		get: (note: Ref<'note', 'notes.read'>) => t.get(note),
		create: (
			workspace: Ref<'workspace', 'notes.write'>,
			values: { title: string; body: string | null; word_count?: number; internal?: string | null },
		) => t.insert(workspace, values),
		update: (note: Ref<'note', 'notes.write'>, values: { title?: string; body?: string | null }, expect: number) =>
			t.update(note, values, { expectVersion: expect }),
		remove: (note: Ref<'note', 'notes.delete'>) => t.remove(note),
		move: (note: Ref<'note', 'notes.delete'>, to: Ref<'workspace', 'notes.write'>) => t.move(note, to),
	}))

	const comments = defineChildStore('note_comments', (t) => ({
		ofNote: (note: Ref<'note', 'notes.read'>) => t.select(note, (q) => q.columns(['id', 'body']).orderBy('id')),
		inWorkspaces: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'note_id', 'workspace_id']).orderBy('id')),
		countPerNote: (within: Within<'workspace', 'notes.read'>) => t.aggregate(within, { groupBy: ['note_id'], count: true }),
		get: (note: Ref<'note', 'notes.read'>, id: string) => t.get(note, id),
		add: (note: Ref<'note', 'notes.write'>, body: string) => t.insert(note, { body }),
		edit: (note: Ref<'note', 'notes.write'>, id: string, body: string) => t.update(note, id, { body }),
		remove: (note: Ref<'note', 'notes.write'>, id: string) => t.remove(note, id),
	}))

	return { organizations, workspaces, notes, comments, defineStore, defineChildStore }
}
