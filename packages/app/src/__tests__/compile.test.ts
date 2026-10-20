import { canonicalArtifactJson, canonicalizeArtifact, type ContractArtifact } from '@fabrika/auth-core'
import { tablePolicies } from '@fabrika/db/tables'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, defineApp, defineContract, parseContractArtifact } from '../contract'
import { FILE_LIMITS } from '../contract/defaults'
import { contract } from './fixtures/notes-app/fabrika.contract'
import { contract as scopedContract } from './fixtures/scoped-notes/fabrika.contract'
import { tables as scopedTables } from './fixtures/scoped-notes/src/db/tables'
import { tables as kitTables } from './kit-fixture/src/db/tables'
import { ById } from './kit-fixture/src/schemas'
import { vocabulary as kitVocabulary } from './kit-fixture/src/vocabulary'

/** `notesArtifact` without the auth-core fixture's 0.5 contact form and inbox table, which no 0.7 contract declares. */
const { contact_messages: _inbox, ...noteTables } = notesArtifact.tables

/**
 * What the notes fixture compiles to now: `notesArtifact` stays 0.5-shaped, as the platform reads it, and the fixture
 * no longer declares its contact form, its inbox or its file collection. Its file kind takes the collection's place.
 */
function notesArtifactWithoutRemovedForms(): ContractArtifact {
	const { 'file:attachments': _fileDimension, ...dimensions } = notesArtifact.dimensions
	const { contact: _form, ...mounts } = notesArtifact.mounts
	return {
		...notesArtifact,
		dimensions,
		mounts,
		tables: noteTables,
		files: {},
		fileKinds: { attachments: { types: ['application/pdf', 'image/png'], maxBytes: 26214400 } },
		endpoints: notesArtifact.endpoints.filter((row) => row.id !== 'contact' && row.source.kind !== 'files'),
	}
}

describe('compileContract', () => {
	const artifact = compileContract(contract, noteTables)

	test('compiles the notes contract to the artifact auth-core describes, without its 0.5-only parts', () => {
		expect(artifact).toEqual(canonicalizeArtifact(notesArtifactWithoutRemovedForms()))
	})

	test('generates no file collection endpoint and no webhook binding endpoint', () => {
		expect(artifact.endpoints.filter((row) => row.id.startsWith('files.') || row.id.startsWith('webhooks.'))).toEqual([])
		expect(artifact.files).toEqual({})
	})

	test('is plain JSON that the artifact parser reads back unchanged', () => {
		const json: unknown = JSON.parse(JSON.stringify(artifact))
		expect(json).toEqual(artifact)
		expect(parseContractArtifact(json)).toEqual(artifact)
	})

	test('normalizes every optional field to null, [] or {}', () => {
		expect(artifact.dimensions['note']).toEqual({ in: 'workspace', creator: null, members: null })
		expect(artifact.roles['starter']).toEqual({ grants: ['workspaces.create'], member: null })
		expect(artifact.csp.imgSrc).toEqual([])
	})
})

describe('a file kind that scans its files', () => {
	const withKind = (kind: { readonly scan?: boolean; readonly maxBytes: number; readonly types?: readonly [string, ...string[]] }) =>
		defineContract({
			app: 'notes',
			dimensions: { workspace: {}, note: { in: 'workspace' } },
			actions: { 'notes.read': 'Read' },
			roles: { editor: { grants: ['notes.read'] } },
		}, (c) => ({
			files: { attachments: c.files({ types: ['application/pdf'], ...kind }) },
			health: c.health('/healthz'),
		}))

	test('carries scan: true only when it scans, so the artifact of one that does not is what it was before', () => {
		expect(compileContract(withKind({ scan: true, maxBytes: 1024 }), {}).fileKinds?.['attachments']?.scan).toBe(true)
		for (const scan of [false, undefined]) {
			const artifact = compileContract(withKind({ ...(scan === undefined ? {} : { scan }), maxBytes: 1024 }), {})
			expect(Object.keys(artifact.fileKinds?.['attachments'] ?? {})).not.toContain('scan')
			expect(canonicalArtifactJson(artifact)).not.toContain('"scan"')
		}
	})

	test('admits no file larger than the scanner reads in full', () => {
		const tooLarge = FILE_LIMITS.maxScannedBytes + 1
		expect(() => compileContract(withKind({ scan: true, maxBytes: tooLarge }), {})).toThrow(
			`files 'attachments': scans its files and admits ${tooLarge} bytes per file; the scanner gives a clean verdict to at most ${FILE_LIMITS.maxScannedBytes}`,
		)
		expect(() => compileContract(withKind({ maxBytes: tooLarge }), {})).not.toThrow('the scanner gives a clean verdict')
	})

	test('admits no archive the framework does not open', () => {
		const gzip = (scan: boolean) => withKind({ scan, maxBytes: 1024, types: ['application/gzip'] })
		expect(() => compileContract(gzip(true), {})).toThrow("files 'attachments': scans its files and admits 'application/gzip'")
		expect(() => compileContract(gzip(false), {})).not.toThrow()
	})
})

describe('compileContract over defineTables output', () => {
	test('gives the artifact the artifact form of the same policies gives', () => {
		const artifact = compileContract(scopedContract, scopedTables)
		expect(artifact).toEqual(compileContract(scopedContract, tablePolicies(scopedTables)))
		const { notes } = artifact.tables
		expect(notes?.scope).toEqual({
			mode: 'dimension',
			dimension: 'note',
			key: 'id',
			container: { dimension: 'workspace', column: 'workspace_id' },
		})
	})

	test("@fabrika/app/contract and an application's src/db/tables.ts on @fabrika/db/tables bundle for a browser", async () => {
		// One build for both: a second Bun.build in the same process fails to re-read a file the first one read.
		const entrypoints = [
			join(import.meta.dir, '..', 'contract', 'index.ts'),
			join(import.meta.dir, 'fixtures', 'scoped-notes', 'src', 'db', 'tables.ts'),
		]
		const built = await Bun.build({ entrypoints, target: 'browser' })
		expect(built.success).toBe(true)
		expect(built.outputs.length).toBe(2)
		for (const output of built.outputs) {
			const text = await output.text()
			expect(text).not.toContain('kysely')
			expect(text).not.toMatch(/from ['"]bun['"]/)
		}
	})
})

describe('the canonical artifact', () => {
	const vocabulary = {
		app: 'tasks',
		dimensions: { workspace: {} },
		actions: { 'tasks.read': 'Read tasks', 'tasks.write': 'Write tasks' },
		roles: { reader: { grants: ['tasks.read'] }, writer: { grants: ['tasks.write', 'tasks.read'] } },
	} as const
	const output = z.strictObject({ ok: z.boolean() })

	test('a contract declared in another order serializes to the same bytes', () => {
		const first = defineContract(vocabulary, (c) => ({
			api: c.rpc('/api', { callers: ['human', 'machine'] }, {
				a: c.query({ output, access: { action: 'tasks.read', over: 'workspace' } }),
				b: c.mutation({ output, access: { action: 'tasks.write', over: 'workspace' } }),
			}),
			health: c.health('/healthz'),
		}))
		const second = defineContract(
			{ ...vocabulary, roles: { writer: { grants: ['tasks.read', 'tasks.write'] }, reader: { grants: ['tasks.read'] } } },
			(c) => ({
				health: c.health('/healthz'),
				api: c.rpc('/api', { callers: ['machine', 'human'] }, {
					b: c.mutation({ output, access: { action: 'tasks.write', over: 'workspace' } }),
					a: c.query({ output, access: { action: 'tasks.read', over: 'workspace' } }),
				}),
			}),
		)
		const one = compileContract(first, {})
		const two = compileContract(second, {})
		expect(one.endpoints.map((row) => row.id)).toEqual(['api.a', 'api.b', 'health'])
		expect(two).toEqual(one)
		expect(canonicalArtifactJson(two)).toBe(canonicalArtifactJson(one))
	})
})

describe('parseContractArtifact', () => {
	const artifact: ContractArtifact = compileContract(contract, noteTables)

	test('refuses an unknown field, a public caller and a missing normalized field', () => {
		expect(() => parseContractArtifact({ ...artifact, extra: true })).toThrow()
		const [first] = artifact.endpoints
		expect(() => parseContractArtifact({ ...artifact, endpoints: [{ ...first, callers: ['public'] }] })).toThrow()
		const { csp: _csp, ...withoutCsp } = artifact
		expect(() => parseContractArtifact(withoutCsp)).toThrow()
	})

	test("reads a table operation's one action as text (a 0.5 artifact's form) and several as a list of at least two", () => {
		const notes = artifact.tables['notes']
		if (notes === undefined) throw new Error('the fixture has a notes table')
		const withRead = (read: unknown) => ({ ...artifact, tables: { ...artifact.tables, notes: { ...notes, actions: { ...notes.actions, read } } } })
		expect(parseContractArtifact(artifact).tables['notes']?.actions.read).toBe('notes.read')
		expect(parseContractArtifact(withRead(['notes.read', 'notes.admin'])).tables['notes']?.actions.read).toEqual(['notes.read', 'notes.admin'])
		expect(() => parseContractArtifact(withRead(['notes.read']))).toThrow()
		expect(() => parseContractArtifact(withRead(['notes.read', 'notes.read']))).toThrow()
		expect(() => parseContractArtifact(withRead(['notes.*', 'notes.read']))).toThrow()
	})

	test('refuses every form only an installation row may use (ADR-0022 "Installation entries")', () => {
		const credentialed = artifact.endpoints.findIndex((row) => row.requirement !== null)
		const anonymous = artifact.endpoints.findIndex((row) => row.requirement === null)
		const replaced = (index: number, fields: Record<string, unknown>) => ({
			...artifact,
			endpoints: artifact.endpoints.map((row, at) => (at === index ? { ...row, ...fields } : row)),
		})
		const variants = [
			replaced(anonymous, { kind: 'protocol' }),
			replaced(credentialed, { kind: 'service' }),
			replaced(credentialed, { method: '*' }),
			replaced(credentialed, { callers: ['oauth'] }),
			replaced(credentialed, { requirement: { kind: 'authenticated' } }),
			replaced(credentialed, { oauth: { scopes: ['authoring'] } }),
		]
		for (const variant of variants) {
			expect(() => parseContractArtifact(variant)).toThrow()
		}
		expect(parseContractArtifact(replaced(credentialed, {}))).toEqual(artifact)
		expect(parseContractArtifact(replaced(anonymous, {}))).toEqual(artifact)
	})

	test("refuses an export row that requires no action: the consumer's key holds exactly the export's actions", () => {
		const endpoints = artifact.endpoints.map((row) => (row.source.kind === 'export' ? { ...row, requirement: { kind: 'member' } } : row))
		expect(endpoints.some((row) => row.source.kind === 'export')).toBe(true)
		expect(() => parseContractArtifact({ ...artifact, endpoints })).toThrow('an export row requires an action')
	})

	test('refuses an app:<id> caller anywhere but an export row', () => {
		const index = artifact.endpoints.findIndex((row) => row.source.kind === 'mount' && row.callers.length > 0)
		const row = artifact.endpoints[index]
		const api = artifact.mounts['api']
		if (row === undefined || api?.kind !== 'rpc') throw new Error('the notes fixture changed')
		const endpoints = artifact.endpoints.map((each, at) => (at === index ? { ...each, callers: ['app:billing'] } : each))
		expect(() => parseContractArtifact({ ...artifact, endpoints })).toThrow('an app:<id> caller reaches only an export row')
		expect(() => parseContractArtifact({ ...artifact, mounts: { ...artifact.mounts, api: { ...api, callers: ['app:billing'] } } })).toThrow()
	})

	test('refuses a wildcard wherever the artifact names an action', () => {
		const owner = artifact.roles['owner']
		const workspace = artifact.dimensions['workspace']
		const shared = artifact.mounts['shared']
		const index = artifact.endpoints.findIndex((row) => row.requirement?.kind === 'action')
		const row = artifact.endpoints[index]
		if (owner === undefined || workspace?.members == null || shared?.kind !== 'link' || row?.requirement?.kind !== 'action') {
			throw new Error('the notes fixture changed')
		}
		const variants: unknown[] = [
			{ ...artifact, actions: { ...artifact.actions, 'notes.*': 'Everything' } },
			{ ...artifact, roles: { ...artifact.roles, owner: { ...owner, grants: [...owner.grants, '*'] } } },
			{ ...artifact, dimensions: { ...artifact.dimensions, workspace: { ...workspace, members: { ...workspace.members, manage: 'notes.*' } } } },
			{ ...artifact, mounts: { ...artifact.mounts, shared: { ...shared, grants: ['notes.*'] } } },
			{
				...artifact,
				endpoints: artifact.endpoints.map((each, at) => (at === index ? { ...row, requirement: { ...row.requirement, action: 'notes.*' } } : each)),
			},
		]
		for (const variant of variants) {
			expect(() => parseContractArtifact(variant)).toThrow('an action is exact; * is not an action')
		}
	})

	test("refuses one of IAM's own role keys as a role or an assigner", () => {
		const owner = artifact.roles['owner']
		if (owner?.member == null) {
			throw new Error('the notes fixture changed')
		}
		const message = 'a built-in IAM role key is not a contract role name'
		expect(() => parseContractArtifact({ ...artifact, roles: { ...artifact.roles, admin: { grants: ['notes.read'], member: null } } })).toThrow(message)
		expect(() =>
			parseContractArtifact({ ...artifact, roles: { ...artifact.roles, owner: { ...owner, member: { ...owner.member, assignableBy: ['admin'] } } } })
		)
			.toThrow(message)
	})
})

describe('parseContractArtifact of a kit contract that kicks and mails', () => {
	const kit = defineApp(kitVocabulary, kitTables)
	const contract = kit.contract((c) => ({
		api: c.rpc('/api', {
			deals: kit.group({ callers: ['human'] }, (r) => ({
				touch: r.mutation({ input: ById, output: ById, access: { action: 'deals.write', on: 'deal', from: 'id' }, kicks: ['notify'] })
					.handle(({ ctx }) => {
						ctx.kick('notify')
						return { id: ctx.target.value }
					}),
			})),
		}),
		jobs: { notify: kit.cron('* * * * *', { actions: ['crm.read'], mailer: 'installation' }).handle(async () => {}) },
	}))
	const artifact = compileContract(contract, kitTables)

	test('reads kicks and mailer back unchanged, each under its site', () => {
		expect(artifact.declared).toEqual({
			'api.deals.touch': { sql: null, unscoped: {}, connect: [], issues: null, kicks: ['notify'] },
			'job:notify': { sql: null, unscoped: {}, connect: [], issues: null, mailer: 'installation' },
		})
		const json: unknown = JSON.parse(JSON.stringify(artifact))
		expect(parseContractArtifact(json)).toEqual(artifact)
	})

	test('refuses a mailer that is no transport and a kick that is no name', () => {
		const declared = artifact.declared ?? {}
		const job = declared['job:notify']
		const endpoint = declared['api.deals.touch']
		if (job === undefined || endpoint === undefined) throw new Error('the contract changed')
		expect(() => parseContractArtifact({ ...artifact, declared: { ...declared, 'job:notify': { ...job, mailer: 'smtp' } } })).toThrow()
		expect(() => parseContractArtifact({ ...artifact, declared: { ...declared, 'api.deals.touch': { ...endpoint, kicks: [''] } } })).toThrow()
	})
})
