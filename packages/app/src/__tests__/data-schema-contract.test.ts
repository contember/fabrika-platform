// A contract whose schemas are held as data compiles to the artifact of the same contract written with zod, and the
// application serving it validates its input and output as the zod one does.

import { compileContract } from '@fabrika/app/contract'
import { type ContractArtifact, contractDigest, encodedArtifactJson, type EndpointRow, FABRIKA_CONTRACT_DIGEST } from '@fabrika/auth-core'
import { describe, expect, spyOn, test } from 'bun:test'
import { implement } from '../implement/implement'
import { contract as zodContract } from './fixtures/implement/fabrika.contract'
import { contract } from './fixtures/implement/fabrika.data-contract'
import { bootApp, environment, frameworkEnvFor, grant, resultOf, send, token } from './fixtures/implement/harness'
import { noteDatabase, type NoteRow, notesStore } from './fixtures/implement/stores'

function notesDataApp(rows: Map<string, NoteRow>) {
	return implement(contract, {
		database: noteDatabase(rows),
		deps: (_env, { capabilities }) => ({ notes: notesStore(capabilities, rows) }),
		handlers: ({ notes }) => ({
			api: {
				me: ({ ctx }) => ({ id: ctx.principal.id, label: ctx.principal.label }),
				notes: {
					list: ({ ctx }) => ({ items: notes.list(ctx.within).map((note) => ({ id: note.id, title: note.title })) }),
					get: ({ ctx }) => {
						const note = notes.get(ctx.target)
						return { id: note.id, title: note.title }
					},
					create: ({ input, ctx }) => {
						const note = notes.insert(ctx.target, input.title)
						return { id: note.id, title: note.title }
					},
					remove: ({ ctx }) => {
						notes.remove(ctx.target)
						return { deleted: ctx.target.value }
					},
				},
			},
			machine: { importNotes: ({ input }) => ({ imported: input.titles.length }) },
		}),
	})
}

describe('a contract of schemas held as data', () => {
	test('compiles to the artifact and the digest of the same contract written with zod', () => {
		const artifact = compileContract(contract, {})
		expect(artifact).toEqual(compileContract(zodContract, {}))
		expect(contractDigest(artifact)).toBe(contractDigest(compileContract(zodContract, {})))
	})

	test('validates the input and the output as zod does', async () => {
		const served = bootApp(notesDataApp(new Map()))
		const writer = await token('user', [grant('notes.write', { type: 'workspace', value: 'w1' })])
		const refused = await send(served, '/api/notes.create', { token: writer, body: { workspaceId: 'w1', title: '' } })
		expect(refused.status).toBe(400)
		expect(JSON.stringify(refused.body)).toContain('"path":"title"')
		const extra = await send(served, '/api/notes.create', { token: writer, body: { workspaceId: 'w1', title: 'a', extra: 1 } })
		expect(extra.status).toBe(400)
		const created = resultOf(await send(served, '/api/notes.create', { token: writer, body: { workspaceId: 'w1', title: 'a' } }))
		expect(created).toMatchObject({ title: 'a' })
	})
})

describe('validation by the approved shapes', () => {
	const compiled = compileContract(contract, notesDataApp(new Map()).database?.tables ?? {})
	const approving = (artifact: ContractArtifact) => {
		const app = notesDataApp(new Map())
		return bootApp(app, {
			environment: environment({ ...frameworkEnvFor(app), [FABRIKA_CONTRACT_DIGEST]: contractDigest(artifact) }),
			approvedContract: encodedArtifactJson(artifact),
		})
	}
	// The approved contract asks a title of two characters at least; the evaluated module asks one.
	const longerTitle = (row: EndpointRow): EndpointRow => {
		const title = row.input?.type === 'object' ? row.input.fields['title'] : undefined
		if (row.id !== 'api.notes.create' || row.input?.type !== 'object' || title?.type !== 'string') {
			return row
		}
		return { ...row, input: { ...row.input, fields: { ...row.input.fields, title: { ...title, minLength: 2 } } } }
	}
	const stricter: ContractArtifact = { ...compiled, endpoints: compiled.endpoints.map(longerTitle) }

	test('an endpoint whose evaluated schema is the approved one validates with it', async () => {
		const served = approving(compiled)
		const writer = await token('user', [grant('notes.write', { type: 'workspace', value: 'w1' })])
		expect(resultOf(await send(served, '/api/notes.create', { token: writer, body: { workspaceId: 'w1', title: 'a' } }))).toMatchObject({ title: 'a' })
	})

	test('an endpoint whose evaluated schema is not the approved one serves nothing; the others serve', async () => {
		const served = approving(stricter)
		const writer = await token('user', [grant('notes.write', { type: 'workspace', value: 'w1' })])
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const refused = await send(served, '/api/notes.create', { token: writer, body: { workspaceId: 'w1', title: 'a' } })
			expect(refused).toMatchObject({ status: 500, body: { error: { type: 'internal' } } })
			expect(log.mock.calls.map((line) => String(line[0]))).toEqual([
				'fabrika: api.notes.create: framework_fault: schema_unapproved: a schema the application evaluated has another shape than its approved contract holds for the endpoint',
			])
		} finally {
			log.mockRestore()
		}
		expect(resultOf(await send(served, '/api/me', { token: writer, body: {} }))).toMatchObject({ id: expect.any(String) })
	})
})
