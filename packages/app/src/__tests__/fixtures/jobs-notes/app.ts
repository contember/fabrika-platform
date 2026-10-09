// The application of the jobs fixture: each job reaches the notes only through the capabilities its ctx mints.

import { implement, type JobContext } from '@fabrika/app/implement'
import { type Ref, scoped, type Within } from '@fabrika/db'
import { tables } from '../scoped-notes/src/db/tables'
import { contract, filesContract, startingContract } from './fabrika.contract'

type Dimension = 'workspace' | 'note'

export interface NoteRows {
	list(within: Within<'workspace', 'notes.read'>): Promise<{ readonly id: string; readonly title: string }[]>
	remove(note: Ref<'note', 'notes.delete'>): Promise<void>
}

/** Where the tests pause or fail a job. */
export interface JobHooks {
	/** Before each delete of `purge` and `sweep`. */
	readonly beforeDelete: (job: string, ctx: JobContext<'notes.read' | 'notes.delete', Dimension>) => Promise<void>
	/** Every attempt of `flaky`; a throw fails the attempt. */
	readonly flaky: (ctx: JobContext<'notes.read', Dimension>, notes: NoteRows) => Promise<void>
}

export function jobsApp(hooks: JobHooks) {
	const database = scoped(tables)
	const notes: NoteRows = database.defineStore('notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
		remove: (note: Ref<'note', 'notes.delete'>) => t.remove(note),
	}))
	const deleteExpired = async (job: string, ctx: JobContext<'notes.read' | 'notes.delete', Dimension>): Promise<void> => {
		for (const note of await notes.list(ctx.within('notes.read', 'workspace'))) {
			if (note.title === 'expired') {
				const target = await ctx.ref('notes.delete', 'note', note.id)
				await hooks.beforeDelete(job, ctx)
				await notes.remove(target)
			}
		}
	}
	return implement(contract, {
		database,
		deps: () => ({}),
		handlers: () => ({
			api: { notes: { list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }) } },
			jobs: {
				purge: ({ ctx }) => deleteExpired('purge', ctx),
				sweep: ({ ctx }) => deleteExpired('sweep', ctx),
				flaky: ({ ctx }) => hooks.flaky(ctx, notes),
			},
		}),
	})
}

/** The jobs contract with an endpoint that creates a workspace, so `boot` needs IAM's membership transport. */
export function startingJobsApp() {
	return implement(startingContract, {
		database: scoped(tables),
		deps: () => ({}),
		handlers: () => ({
			api: { start: ({ ctx }) => ({ workspace: ctx.created.value }) },
			jobs: { purge: () => Promise.resolve() },
		}),
	})
}

/** The jobs contract with a file collection, so `boot` needs the object storage the platform wrote. */
export function filesJobsApp() {
	const database = scoped(tables)
	const notes = database.defineStore('notes', (t) => ({
		list: (within: Within<'workspace', 'notes.read'>) => t.select(within, (q) => q.columns(['id', 'title']).orderBy('id')),
	}))
	return implement(filesContract, {
		database,
		deps: () => ({}),
		handlers: () => ({
			api: { notes: { list: async ({ ctx }) => ({ items: await notes.list(ctx.within) }) } },
			jobs: { purge: () => Promise.resolve() },
		}),
	})
}
