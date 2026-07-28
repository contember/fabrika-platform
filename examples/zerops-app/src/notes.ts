// The app's own data. Deliberately behind a small interface so the request handler can be tested
// without a database — the interesting part of this example is the authorization path, and a test that
// needs Postgres to prove a `can()` check is a test nobody runs.

import { SQL } from 'bun'

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Narrow a driver row structurally rather than trusting its shape. */
const toNote = (row: unknown): Note | null => {
	if (!isRecord(row)) {
		return null
	}
	const { id, workspace, title } = row
	if (typeof id !== 'string' || typeof workspace !== 'string' || typeof title !== 'string') {
		return null
	}
	return { id, workspace, title }
}

export class PostgresNotes implements NotesStore {
	constructor(private readonly sql: SQL) {}

	async list(workspace: string): Promise<Note[]> {
		const rows: unknown = await this.sql`SELECT id, workspace, title FROM notes WHERE workspace = ${workspace} ORDER BY title LIMIT 200`
		if (!Array.isArray(rows)) {
			return []
		}
		return rows.flatMap((row) => {
			const note = toNote(row)
			return note === null ? [] : [note]
		})
	}

	async create(note: Note): Promise<void> {
		await this.sql`INSERT INTO notes (id, workspace, title) VALUES (${note.id}, ${note.workspace}, ${note.title})`
	}

	async remove(workspace: string, id: string): Promise<boolean> {
		const rows: unknown = await this.sql`DELETE FROM notes WHERE workspace = ${workspace} AND id = ${id} RETURNING id`
		return Array.isArray(rows) && rows.length > 0
	}
}
