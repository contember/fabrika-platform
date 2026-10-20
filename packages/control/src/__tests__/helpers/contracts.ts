// A contract application's source, as Control reads it at a commit, and edits of it for the approval tests.

import type { TablePolicyArtifact as TablePolicyArtifact05 } from '@fabrika/auth-core-0.5'
import { CHECKER_VERSION as CHECKER_05, readContractSource as readContractSource05 } from '@fabrika/check-0.5/contract'
import { fromOlder } from '../../approval/formats'
import type { AccessSnapshot } from '../../approval/snapshot'

export const BASE = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'

const Note = z.strictObject({ id: z.uuid(), title: z.string() })

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes', 'notes.write': 'Write notes', 'notes.delete': 'Delete notes' },
	roles: {
		owner: { grants: ['notes.read', 'notes.write', 'notes.delete'], member: { scope: 'workspace', assignableBy: ['owner'] } },
		editor: { grants: ['notes.read', 'notes.write'], member: { scope: 'workspace', assignableBy: ['owner'] } },
	},
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
		get: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),
		remove: c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } }),
	}),
	health: c.health('/healthz'),
	app: c.spa('/', { dir: 'dist/app', access: { member: true } }),
}))
`

/** `BASE` with one exact passage replaced; a passage that is not there is a broken test. */
export const edited = (search: string, replacement: string, text = BASE): string => {
	if (!text.includes(search)) throw new Error(`the base has no '${search}'`)
	return text.replace(search, replacement)
}

/** `BASE` with one more query procedure, `api.export`: a widening against `BASE`. */
export const WITH_EXPORT = edited(
	'\t}),\n\thealth',
	`\t\texport: c.query({ input: z.strictObject({ id: z.uuid() }), output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } }),\n\t}),\n\thealth`,
)

/** `BASE` without the `remove` procedure: a removal against `BASE`, its path then denied. */
export const WITHOUT_REMOVE = edited(
	`\t\tremove: c.mutation({ input: z.strictObject({ id: z.uuid() }), output: z.strictObject({ id: z.uuid() }), access: { action: 'notes.delete', on: 'note', from: 'id' } }),\n`,
	'',
)

/** The smallest contract an application `app` deploys with: one anonymous health check. */
export const healthOnly = (app: string): string =>
	`import { defineContract } from '@fabrika/app/contract'

export const contract = defineContract({ app: '${app}', dimensions: {}, actions: {}, roles: {} }, (c) => ({ health: c.health('/healthz') }))
`

/**
 * The snapshot of a 0.5 application's commit, read by its own release's reader and upcast (ADR-0062). The forms, file
 * collections and `then` that this release's framework no longer authors are approved and served this way.
 * `files` are the commit's other files; without `tables` the reader reads them from `src/db/tables.ts`.
 */
export function snapshot05(
	contract: string,
	tables?: Readonly<Record<string, TablePolicyArtifact05>>,
	files: Readonly<Record<string, string>> = {},
): AccessSnapshot {
	const sources = new Map(Object.entries({ ...files, 'fabrika.contract.ts': contract }))
	return { version: 1, ...fromOlder(readContractSource05(sources, tables)), migrations: [], checker: CHECKER_05 }
}
