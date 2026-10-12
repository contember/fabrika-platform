// The endpoint access cases the scaffold writes for a kit application (`@fabrika/app`'s `access-fixture/`): a write
// that reads its own target and a link holder get an own-target case, a report `in` a scope through `ctx.sql` gets a
// leak case, an `unscoped` endpoint keeps its denial and loses its leak case, and an author's seed adds a seeded leak case
// beside the unseeded one and reaches the own-target case. The kit runs these cases against Postgres in `@fabrika/app`'s
// `endpoint-access.test.ts`.

import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { ENDPOINT_ACCESS_TEST, ENDPOINT_FIXTURES_FILE, generatedTests, missingEndpointFixtures, scaffoldInputs } from '../scaffold'

const ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'access-fixture')

const MEMBERS_ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'members-fixture')

const tree = (root = ROOT): Map<string, string> => {
	const files = new Map<string, string>()
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir)) {
			const path = join(dir, name)
			if (statSync(path).isDirectory()) walk(path)
			else files.set(relative(root, path), readFileSync(path, 'utf8'))
		}
	}
	walk(root)
	return files
}

const endpointTest = async (files: ReadonlyMap<string, string>): Promise<string> => {
	const inputs = scaffoldInputs(files)
	return (await generatedTests(inputs.policies, inputs.artifact, inputs.fixtures)).get(ENDPOINT_ACCESS_TEST)?.text ?? ''
}

const VERSIONED = "{ expectVersion: 1, id: '00000000-0000-4000-8000-000000000000' }"

describe('the endpoint access cases of a kit application', () => {
	test('a write action and a link holder reach their own target; a read action has only its leak case', async () => {
		const text = await endpointTest(tree())
		expect(text).toContain(`expect(await kit.own('api.notes.trash', ${VERSIONED})).toEqual({ status: 200 })`)
		expect(text).toContain("test('api.notes.trash: a caller with only notes.write reaches its own note'")
		expect(text).toContain("expect(await kit.own('shared.note', {})).toEqual({ status: 200 })")
		expect(text).not.toContain("kit.own('api.notes.get'")
		expect(text).toContain(
			"expect(await kit.leaked('api.notes.get', { id: '00000000-0000-4000-8000-000000000000' })).toEqual({ answered: true, leaked: [] })",
		)
	})

	test('a report in a scope through ctx.sql gets a leak case; an in endpoint without sql keeps only its denial', async () => {
		const text = await endpointTest(tree())
		expect(text).toContain("expect(await kit.leaked('api.notes.titles', { organizationId: 'x' })).toEqual({ answered: true, leaked: [] })")
		expect(text).toContain("expect(await kit.denied('api.notes.titles', { organizationId: 'x' })).toEqual({ status: 403 })")
	})

	test('an endpoint that declares unscoped keeps its denial and has no leak case', async () => {
		const files = tree()
		const endpoints = files.get('src/notes/endpoints.ts') ?? ''
		const declared = endpoints.replace(
			"output: Note, access: { action: 'notes.read', on: 'note', from: 'id' } })",
			"output: Note, access: { action: 'notes.read', on: 'note', from: 'id' }, unscoped: { notes: 'read' } })",
		)
		expect(declared).not.toBe(endpoints)
		const text = await endpointTest(new Map([...files, ['src/notes/endpoints.ts', declared]]))
		expect(text).toContain("expect(await kit.denied('api.notes.get', { id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 404 })")
		expect(text).not.toContain("kit.leaked('api.notes.get'")
	})

	test('the unseeded leak case always runs, the seed adds a seeded one and reaches the own-target case, and a seed of no addressed row is a finding', async () => {
		const seeded = new Map([...tree(), [ENDPOINT_FIXTURES_FILE, "export const seeds = { 'api.notes.restore': { trashed: true } }\n"]])
		const text = await endpointTest(seeded)
		expect(text).toContain(`expect(await kit.leaked('api.notes.restore', ${VERSIONED})).toEqual({ answered: true, leaked: [] })`)
		expect(text).toContain(`expect(await kit.leaked('api.notes.restore', ${VERSIONED}, { trashed: true })).toEqual({ answered: true, leaked: [] })`)
		expect(text).toContain("test('api.notes.restore: with its seed, the answer to one scope holds nothing of the scope answered before it'")
		expect(text).toContain(`kit.own('api.notes.restore', ${VERSIONED}, { trashed: true })`)
		expect(text).toContain(`kit.denied('api.notes.restore', ${VERSIONED})`)
		expect(missingEndpointFixtures(scaffoldInputs(seeded))).toEqual([])
		const stray = new Map([...seeded, [ENDPOINT_FIXTURES_FILE, "export const seeds = { 'api.notes.list': { trashed: true } }\n"]])
		expect(missingEndpointFixtures(scaffoldInputs(stray)).map((finding) => finding.message)).toEqual([
			'api.notes.list is no endpoint with an on or in access form, whose row a seed sets',
		])
	})

	test('the fixtures file holds fixtures and seeds, each once, and nothing else', () => {
		const read = (text: string) => scaffoldInputs(new Map([...tree(), [ENDPOINT_FIXTURES_FILE, text]])).fixtures
		expect(read("export const seeds = { 'api.notes.restore': { trashed: true } }\nexport const fixtures = {}\n")).toEqual({
			inputs: {},
			seeds: { 'api.notes.restore': { trashed: true } },
			members: {},
		})
		expect(() => read('export const seeds = {}\nexport const seeds = {}\n')).toThrow()
		expect(() => read('export const setup = {}\n')).toThrow()
	})
})

describe('the policy isolation cases of a column policy', () => {
	test('a column with its own read action gets its hidden-column case; one with only a write action is returned and gets none', async () => {
		const inputs = scaffoldInputs(tree())
		const [table, policy] = Object.entries(inputs.policies)[0] ?? []
		if (table === undefined || policy === undefined) throw new Error('the access fixture declares no table')
		const columns = { kept: { write: 'notes.write' }, secret: { read: 'notes.write' } }
		const tests = await generatedTests({ ...inputs.policies, [table]: { ...policy, columns } }, inputs.artifact, inputs.fixtures)
		const text = tests.get(`src/db/__tests__/${table}.policy-isolation.test.ts`)?.text ?? ''
		expect(text).toContain('get leaves out secret, which has its own read action')
		expect(text).not.toContain('leaves out kept')
	})
})

describe('the members of the fixtures: input fields that name a member the handler looks up', () => {
	const members = (text: string) => new Map([...tree(MEMBERS_ROOT), [ENDPOINT_FIXTURES_FILE, text]])

	test("each case sends the kit's member in the field, whatever the sample was", async () => {
		const text = await endpointTest(tree(MEMBERS_ROOT))
		const input = "{ expectVersion: 1, id: '00000000-0000-4000-8000-000000000000', newOwner: 'fabrika:member' }"
		expect(text).toContain(`expect(await kit.own('api.deals.assign', ${input})).toEqual({ status: 200 })`)
		expect(text).toContain(`expect(await kit.denied('api.deals.assign', ${input})).toEqual({ status: 404 })`)
		expect(text).toContain("kit.own('api.deals.candidate', { id: '00000000-0000-4000-8000-000000000000', principalId: 'x' })")
		expect(missingEndpointFixtures(scaffoldInputs(tree(MEMBERS_ROOT)))).toEqual([])
	})

	test('a member field of an endpoint with no directory, of no endpoint, or that is no string field is a finding', () => {
		const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(members(text))).map((finding) => finding.message)
		expect(findings("export const members = { 'api.deals.assign': ['expectVersion'] }\n")).toEqual([
			'api.deals.assign: expectVersion is no string field of its input, so it cannot name a member',
		])
		expect(findings("export const members = { 'api.deals.missing': ['newOwner'] }\n")).toEqual([
			'api.deals.missing is no tested endpoint below a dimension with members, whose handler could look one up',
		])
		const unlisted = new Map([...tree(), [ENDPOINT_FIXTURES_FILE, "export const members = { 'api.notes.trash': ['id'] }\n"]])
		expect(missingEndpointFixtures(scaffoldInputs(unlisted)).map((finding) => finding.message)).toEqual([
			'api.notes.trash is no tested endpoint below a dimension with members, whose handler could look one up',
		])
	})

	test('the members are lists of field names, declared once', () => {
		const read = (text: string) => scaffoldInputs(members(text)).fixtures
		expect(read("export const members = { 'api.deals.assign': ['newOwner'] }\n").members).toEqual({ 'api.deals.assign': ['newOwner'] })
		expect(() => read("export const members = { 'api.deals.assign': 'newOwner' }\n")).toThrow()
		expect(() => read("export const members = { 'api.deals.assign': [] }\n")).toThrow()
		expect(() => read('export const members = {}\nexport const members = {}\n')).toThrow()
	})
})
