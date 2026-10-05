// The app's own data. Deliberately behind a small interface so the request handler can be tested
// without a database — the interesting part of this example is the authorization path, and a test that
// needs Postgres to prove a `can()` check is a test nobody runs.

import { SQL } from 'bun'
import { z } from 'zod'

export interface Note {
	id: string
	workspace: string
	title: string
}

export interface NotesStore {
	list(workspace: string): Promise<Note[]>
	create(note: Note): Promise<void>
	remove(workspace: string, id: string): Promise<boolean>
}

const noteSchema = z.object({ id: z.string(), workspace: z.string(), title: z.string() })
const notesRowsSchema = z.array(noteSchema.nullable().catch(null)).catch([])

export const parseNotesRows = (rows: unknown): Note[] => notesRowsSchema.parse(rows).filter((note) => note !== null)

export class PostgresNotes implements NotesStore {
	constructor(private readonly sql: SQL) {}

	async list(workspace: string): Promise<Note[]> {
		const rows: unknown = await this.sql`SELECT id, workspace, title FROM notes WHERE workspace = ${workspace} ORDER BY title LIMIT 200`
		return parseNotesRows(rows)
	}

	async create(note: Note): Promise<void> {
		await this.sql`INSERT INTO notes (id, workspace, title) VALUES (${note.id}, ${note.workspace}, ${note.title})`
	}

	async remove(workspace: string, id: string): Promise<boolean> {
		const rows: unknown = await this.sql`DELETE FROM notes WHERE workspace = ${workspace} AND id = ${id} RETURNING id`
		return Array.isArray(rows) && rows.length > 0
	}
}
