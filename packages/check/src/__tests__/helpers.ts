import { checkApplication } from '../check'
import type { Finding, RuleId } from '../finding'

export const check = (files: Readonly<Record<string, string>>): Promise<Finding[]> =>
	checkApplication({ root: '/application', files: new Map(Object.entries(files)) })

export const locations = (findings: readonly Finding[], rule: RuleId): string[] =>
	findings.filter((finding) => finding.rule === rule).map((finding) => `${finding.file}:${finding.line}:${finding.column}`)

/** A contract that every rule accepts, with one job, for the rules that read the contract. */
export const CLEAN_CONTRACT = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
import { CreateNote, Note } from './src/schemas/notes'

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes' } as const,
	roles: { owner: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
		create: c.mutation({ input: CreateNote, output: Note, access: { action: 'notes.write', in: 'workspace', from: 'workspaceId' } }),
	}),
	purgeDeleted: c.cron('0 3 * * *', { actions: ['notes.write'], scope: 'app' }),
	health: c.health('/healthz'),
}))
`

export const CLEAN_SCHEMAS = `import { z } from 'zod/v4'

export const Note = z.strictObject({ id: z.uuid(), title: z.string().min(1).max(200) })
export const CreateNote = z.strictObject({ workspaceId: z.uuid(), title: z.string().min(1) })
`

export const CLEAN_TABLES = `import { defineTables } from '@fabrika/app/contract'
import type { contract } from '../../fabrika.contract'
import type { DB } from './schema.generated'

export const tables = defineTables<DB, typeof contract>()({
	notes: {
		scope: { dimension: 'note', key: 'id', in: { dimension: 'workspace', column: 'workspace_id' } },
		actions: { read: 'notes.read', insert: 'notes.write', update: 'notes.write', delete: 'notes.write' },
		insert: ['title'],
	},
})
`

export const CLEAN_APPLICATION: Readonly<Record<string, string>> = {
	'fabrika.contract.ts': CLEAN_CONTRACT,
	'src/schemas/notes.ts': CLEAN_SCHEMAS,
	'src/db/tables.ts': CLEAN_TABLES,
}
