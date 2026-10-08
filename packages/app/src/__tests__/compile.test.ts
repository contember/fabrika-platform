import type { ContractArtifact, EndpointRow } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { notesArtifact } from '../../../auth-core/src/__tests__/fixtures/notes-artifact'
import { compileContract, parseContractArtifact } from '../contract'
import { contract } from './fixtures/notes-app/fabrika.contract'

const byId = (rows: readonly EndpointRow[]): EndpointRow[] => [...rows].sort((a, b) => a.id.localeCompare(b.id))

/** The generated file endpoints `notesArtifact` does not list. */
const UNLISTED_FILE_ROWS = new Set(['files.attachments.upload', 'files.attachments.remove'])

describe('compileContract', () => {
	const artifact = compileContract(contract, notesArtifact.tables)

	test('compiles the framework document contract to the artifact auth-core describes', () => {
		const { endpoints, reservedPrefixes, ...rest } = artifact
		const { endpoints: expectedEndpoints, reservedPrefixes: expectedPrefixes, ...expectedRest } = notesArtifact
		expect(rest).toEqual(expectedRest)
		expect(byId(endpoints.filter((row) => !UNLISTED_FILE_ROWS.has(row.id)))).toEqual(byId(expectedEndpoints))
		expect([...reservedPrefixes].sort()).toEqual([...expectedPrefixes].sort())
	})

	test('generates the upload and remove endpoints of a file collection', () => {
		const rows = artifact.endpoints.filter((row) => UNLISTED_FILE_ROWS.has(row.id))
		expect(rows.map(({ id, kind, method, path, callers, requirement, admission }) => ({ id, kind, method, path, callers, requirement, admission })))
			.toEqual([
				{
					id: 'files.attachments.upload',
					kind: 'upload',
					method: 'POST',
					path: '/api/files.attachments.upload/:owner',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'note', from: 'owner' } },
					admission: { contentTypes: ['image/png', 'application/pdf'], maxBytes: 26214400 },
				},
				{
					id: 'files.attachments.remove',
					kind: 'mutation',
					method: 'POST',
					path: '/api/files.attachments.remove',
					callers: ['human'],
					requirement: { kind: 'action', action: 'notes.write', access: { form: 'on', dimension: 'file:attachments', from: 'id' } },
					admission: { contentTypes: ['application/json'], maxBytes: null },
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
