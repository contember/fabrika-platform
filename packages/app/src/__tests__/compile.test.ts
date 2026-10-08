import { canonicalArtifactJson, canonicalizeArtifact, type ContractArtifact } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, defineContract, parseContractArtifact } from '../contract'
import { contract } from './fixtures/notes-app/fabrika.contract'

/** The generated file endpoints `notesArtifact` does not list. */
const UNLISTED_FILE_ROWS = new Set(['files.attachments.upload', 'files.attachments.remove'])

describe('compileContract', () => {
	const artifact = compileContract(contract, notesArtifact.tables)

	test('compiles the framework document contract to the artifact auth-core describes', () => {
		const { endpoints, reservedPrefixes, ...rest } = artifact
		const { endpoints: expectedEndpoints, reservedPrefixes: expectedPrefixes, ...expectedRest } = canonicalizeArtifact(notesArtifact)
		expect(rest).toEqual(expectedRest)
		expect(endpoints.filter((row) => !UNLISTED_FILE_ROWS.has(row.id))).toEqual([...expectedEndpoints])
		expect(reservedPrefixes).toEqual(expectedPrefixes)
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
})
