import { canonicalArtifactJson, canonicalizeArtifact, type ContractArtifact } from '@fabrika/auth-core'
import { tablePolicies } from '@fabrika/db/tables'
import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, defineContract, parseContractArtifact } from '../contract'
import { contract } from './fixtures/notes-app/fabrika.contract'
import { contract as scopedContract } from './fixtures/scoped-notes/fabrika.contract'
import { tables as scopedTables } from './fixtures/scoped-notes/src/db/tables'

/** The generated file endpoints `notesArtifact` does not list. */
const UNLISTED_FILE_ROWS = new Set(['files.attachments.upload', 'files.attachments.remove'])
/** The generated webhook binding endpoints `notesArtifact` does not list. */
const UNLISTED_WEBHOOK_ROWS = new Set(['webhooks.github.bind', 'webhooks.github.unbind'])

describe('compileContract', () => {
	const artifact = compileContract(contract, notesArtifact.tables)

	test('compiles the framework document contract to the artifact auth-core describes', () => {
		const { endpoints, reservedPrefixes, ...rest } = artifact
		const { endpoints: expectedEndpoints, reservedPrefixes: expectedPrefixes, ...expectedRest } = canonicalizeArtifact(notesArtifact)
		expect(rest).toEqual(expectedRest)
		expect(endpoints.filter((row) => !UNLISTED_FILE_ROWS.has(row.id) && !UNLISTED_WEBHOOK_ROWS.has(row.id))).toEqual([...expectedEndpoints])
		expect(reservedPrefixes).toEqual(expectedPrefixes)
	})

	test("generates a webhook's bind and unbind endpoints for a holder of its dimension's members.manage", () => {
		const rows = artifact.endpoints.filter((row) => UNLISTED_WEBHOOK_ROWS.has(row.id))
		const access = { form: 'in', dimension: 'workspace', from: 'scope' } as const
		expect(rows.map(({ id, kind, method, path, callers, requirement, source }) => ({ id, kind, method, path, callers, requirement, source })))
			.toEqual([
				{
					id: 'webhooks.github.bind',
					kind: 'mutation',
					method: 'POST',
					path: '/api/webhooks.github.bind',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.admin', access },
					source: { kind: 'mount', name: 'github' },
				},
				{
					id: 'webhooks.github.unbind',
					kind: 'mutation',
					method: 'POST',
					path: '/api/webhooks.github.unbind',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.admin', access },
					source: { kind: 'mount', name: 'github' },
				},
			])
		expect(artifact.reservedPrefixes).toContain('/api')
	})

	test('generates the upload and remove endpoints of a file collection', () => {
		const rows = artifact.endpoints.filter((row) => UNLISTED_FILE_ROWS.has(row.id))
		expect(rows.map(({ id, kind, method, path, callers, requirement, admission }) => ({ id, kind, method, path, callers, requirement, admission })))
			.toEqual([
				{
					id: 'files.attachments.remove',
					kind: 'mutation',
					method: 'POST',
					path: '/api/files.attachments.remove',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'file:attachments', from: 'id' } },
					admission: { contentTypes: ['application/json'], maxBytes: null },
				},
				{
					id: 'files.attachments.upload',
					kind: 'upload',
					method: 'POST',
					path: '/api/files.attachments.upload/:owner',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'owner' } },
					admission: { contentTypes: ['application/pdf', 'image/png'], maxBytes: 26214400 },
				},
			])
	})

	test('is plain JSON that the artifact parser reads back unchanged', () => {
		const json: unknown = JSON.parse(JSON.stringify(artifact))
		expect(json).toEqual(artifact)
		expect(parseContractArtifact(json)).toEqual(artifact)
	})

	test('normalizes every optional field to null, [] or {}', () => {
		expect(artifact.files['attachments']?.link).toBe(false)
		expect(artifact.dimensions['note']).toEqual({ in: 'workspace', creator: null, members: null })
		expect(artifact.roles['starter']).toEqual({ grants: ['workspaces.create'], member: null })
		expect(artifact.csp.imgSrc).toEqual([])
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
	const artifact: ContractArtifact = compileContract(contract, notesArtifact.tables)

	test('refuses an unknown field, a public caller and a missing normalized field', () => {
		expect(() => parseContractArtifact({ ...artifact, extra: true })).toThrow()
		const [first] = artifact.endpoints
		expect(() => parseContractArtifact({ ...artifact, endpoints: [{ ...first, callers: ['public'] }] })).toThrow()
		const { csp: _csp, ...withoutCsp } = artifact
		expect(() => parseContractArtifact(withoutCsp)).toThrow()
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
