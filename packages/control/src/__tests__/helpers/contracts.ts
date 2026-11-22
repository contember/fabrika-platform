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

/**
 * A contract of `endpoints` query procedures with 160-character names, each with its own output schema, in modules of
 * 100 schemas (one module may hold 512 KiB). At 1400 the stored snapshot is about 1.4 MB and its classification against
 * the empty baseline about 1.36 MB: together over a D1 row, each within the snapshot's own ceiling.
 */
export function largeContract(endpoints: number): { readonly contract: string; readonly files: Record<string, string> } {
	const perModule = 100
	const name = (index: number): string => `q${index}_`.padEnd(160, 'n')
	const files: Record<string, string> = {}
	for (let module = 0; module * perModule < endpoints; module++) {
		const schemas = Array.from({ length: Math.min(perModule, endpoints - module * perModule) }, (_, offset) => {
			const index = module * perModule + offset
			return `export const S${index} = z.strictObject({ ${`f${index}_`.padEnd(40, 'x')}: z.string() })`
		})
		files[`src/large/s${module}.ts`] = `import { z } from 'zod/v4'\n${schemas.join('\n')}\n`
	}
	const imports = Array.from({ length: endpoints }, (_, index) => `import { S${index} } from './src/large/s${Math.floor(index / perModule)}'`)
	const procedures = Array.from(
		{ length: endpoints },
		(_, index) =>
			`\t\t${
				name(index)
			}: c.query({ input: z.strictObject({ id: z.uuid() }), output: S${index}, access: { action: 'notes.read', on: 'note', from: 'id' } }),`,
	)
	const contract = `import { defineContract } from '@fabrika/app/contract'
import { z } from 'zod/v4'
${imports.join('\n')}

export const contract = defineContract({
	app: 'notes',
	dimensions: { workspace: { creator: 'owner' }, note: { in: 'workspace' } },
	actions: { 'notes.read': 'Read notes' },
	roles: { owner: { grants: ['notes.read'], member: { scope: 'workspace', assignableBy: ['owner'] } } },
}, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, {
${procedures.join('\n')}
	}),
	health: c.health('/healthz'),
}))
`
	return { contract, files }
}
