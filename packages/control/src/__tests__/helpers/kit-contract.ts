// A staged-kit application as Control reads it at a commit: the shell, the handlers beside it, and the declarations
// off the paved road each approval test varies.

export interface KitOptions {
	/** The options of `notes.summary` (a query) beyond its access, as source: `sql: 'read'`. */
	readonly summary?: string
	/** The options of `notes.retitle` (a mutation) beyond its access. */
	readonly retitle?: string
	/** The body of `notes.summary`'s handler; a moved or rewritten body declares nothing new. */
	readonly summaryBody?: string
}

const VOCABULARY = `import { defineVocabulary } from '@fabrika/app/contract'

export const vocabulary = defineVocabulary({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' },
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
})
`

const SCHEMA = `import type { TypedColumnList } from '@fabrika/db'

export interface NotesTable {
	id: string
	workspace_id: string
	title: string
}

export interface AuditTable {
	id: string
	workspace_id: string
	note_id: string
}

export interface DB {
	audit: AuditTable
	notes: NotesTable
}

export const columns: TypedColumnList<DB> = {
	audit: { columns: ['id', 'workspace_id', 'note_id'], foreignKeys: [] },
	notes: { columns: ['id', 'workspace_id', 'title'], foreignKeys: [] },
}
`

const TABLES = `import { defineTables } from '@fabrika/db/tables'
import { vocabulary } from '../vocabulary'
import { columns } from './schema.generated'

export const tables = defineTables(vocabulary, columns)({
	notes: {
		scope: { dimension: 'note' },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['title'],
		update: ['title'],
	},
	audit: { scope: { reference: 'the audit trail a trigger writes' }, actions: { read: 'notes.read' } },
})
`

const KIT = `import { defineApp } from '@fabrika/app/contract'
import { tables } from './db/tables'
import { vocabulary } from './vocabulary'

export const app = defineApp(vocabulary, tables)
`

const CONTRACT = `import { app } from './src/app-kit'
import { notes } from './src/notes/endpoints'

export const contract = app.contract((c) => ({
	api: c.rpc('/api', { notes }),
	health: c.health('/healthz'),
}))
`

const DEFAULT_SUMMARY_BODY = `async ({ ctx }) => ({ title: (await ctx.db.target.get()).title })`

function endpoints(options: KitOptions): string {
	const extra = (declared: string | undefined): string => (declared === undefined ? '' : `, ${declared}`)
	return `import { z } from 'zod/v4'
import { app } from '../app-kit'

const ById = z.strictObject({ id: z.uuid() })
const Summary = z.strictObject({ title: z.string() })
const Retitle = z.strictObject({ id: z.uuid(), title: z.string().min(1).max(200) })

export const notes = app.group({ callers: ['human'] }, (r) => ({
	summary: r.query({ input: ById, output: Summary, access: { action: 'notes.read', on: 'note', from: 'id' }${extra(options.summary)} })
		.handle(${options.summaryBody ?? DEFAULT_SUMMARY_BODY}),
	retitle: r.mutation({ input: Retitle, output: ById, access: { action: 'notes.write', on: 'note', from: 'id' }${extra(options.retitle)} })
		.handle(async ({ input, ctx }) => {
			await ctx.db.target.update({ title: input.title })
			return { id: input.id }
		}),
}))
`
}

/** The commit's files, `fabrika.contract.ts` included. */
export function kitFiles(options: KitOptions = {}): Record<string, string> {
	return {
		'fabrika.contract.ts': CONTRACT,
		'src/vocabulary.ts': VOCABULARY,
		'src/db/schema.generated.ts': SCHEMA,
		'src/db/tables.ts': TABLES,
		'src/app-kit.ts': KIT,
		'src/notes/endpoints.ts': endpoints(options),
	}
}

export const NOTES_MIGRATION = {
	name: '20261012090000_notes.sql',
	sql: `CREATE TABLE notes (id uuid PRIMARY KEY, workspace_id text NOT NULL, title text NOT NULL);
CREATE TABLE audit (id uuid PRIMARY KEY, workspace_id text NOT NULL, note_id uuid NOT NULL);
`,
}

/** A trigger that records every retitle in `audit`: database code, declared in a migration. */
export const AUDIT_TRIGGER_MIGRATION = {
	name: '20261012100000_audit_trigger.sql',
	sql: `CREATE FUNCTION record_retitle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	INSERT INTO audit (id, workspace_id, note_id) VALUES (gen_random_uuid(), NEW.workspace_id, NEW.id);
	RETURN NEW;
END
$$;
CREATE TRIGGER audit_retitle AFTER UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION record_retitle();
`,
}
