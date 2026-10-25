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
		// The sample omits an optional field, so the patch sets nothing and answers its acknowledgement.
		expect(text).toContain(`expect(await kit.own('api.notes.retitle', ${VERSIONED})).toEqual({ status: 200 })`)
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
			invitations: {},
			links: {},
			rows: {},
			appRows: {},
			files: {},
			refusals: {},
		})
		expect(read("export const rows = { 'api.notes.get': { commentId: 'note_comments' } }\n").rows).toEqual({
			'api.notes.get': { commentId: 'note_comments' },
		})
		expect(() => read("export const rows = { 'api.notes.get': { commentId: 1 } }\n")).toThrow()
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
		expect(text).toContain("kit.denied('api.deals.check', { companyId: 'x', principalId: 'fabrika:member' })")
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

describe('the invitations and links of the fixtures: input fields that name what a handler cancels or revokes by id', () => {
	const ISOLATION_ROOT = join(import.meta.dir, '..', '..', '..', 'cli', 'src', '__tests__', 'fixtures', 'isolation-app')
	const withFixtures = (text: string) => new Map([...tree(ISOLATION_ROOT), [ENDPOINT_FIXTURES_FILE, text]])
	const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(withFixtures(text))).map((finding) => finding.message)

	test("each case sends the kit's invitation or link in the field", async () => {
		const text = await endpointTest(tree(ISOLATION_ROOT))
		expect(text).toContain("expect(await kit.own('api.workspaces.cancel', { id: 'x', invitationId: 'fabrika:invitation' })).toEqual({ status: 200 })")
		expect(text).toContain("expect(await kit.own('api.notes.unshare', { id: 'x', linkId: 'fabrika:link' })).toEqual({ status: 200 })")
		expect(missingEndpointFixtures(scaffoldInputs(tree(ISOLATION_ROOT)))).toEqual([])
	})

	test('an invitation field of an endpoint that manages no members, a link field of one that issues none, or no string field is a finding', () => {
		expect(findings("export const invitations = { 'api.notes.rename': ['title'] }\n")).toEqual([
			"api.notes.rename is no tested endpoint that manages a dimension's members, whose handler could cancel an invitation",
		])
		expect(findings("export const links = { 'api.workspaces.cancel': ['invitationId'] }\n")).toEqual([
			'api.workspaces.cancel is no tested endpoint that issues a share link, whose handler could revoke one',
		])
		expect(findings("export const invitations = { 'api.workspaces.cancel': ['missing'] }\nexport const links = { 'api.notes.unshare': ['missing'] }\n"))
			.toEqual([
				'api.workspaces.cancel: missing is no string field of its input, so it cannot name an invitation',
				'api.notes.unshare: missing is no string field of its input, so it cannot name a share link',
			])
	})

	test('the invitations and links are lists of field names, each declared once', () => {
		const read = (text: string) => scaffoldInputs(withFixtures(text)).fixtures
		expect(read("export const links = { 'api.notes.unshare': ['linkId'] }\n").links).toEqual({ 'api.notes.unshare': ['linkId'] })
		expect(() => read("export const invitations = { 'api.workspaces.cancel': 'invitationId' }\n")).toThrow()
		expect(() => read('export const links = {}\nexport const links = {}\n')).toThrow()
	})
})

describe('the rows of the fixtures: input fields that name a row lying in the endpoint object', () => {
	const ISOLATION_ROOT = join(import.meta.dir, '..', '..', '..', 'cli', 'src', '__tests__', 'fixtures', 'isolation-app')
	const withFixtures = (text: string) => new Map([...tree(ISOLATION_ROOT), [ENDPOINT_FIXTURES_FILE, text]])
	const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(withFixtures(text))).map((finding) => finding.message)

	test("each case sends the kit's row of the named table in the field", async () => {
		const text = await endpointTest(tree(ISOLATION_ROOT))
		expect(text).toContain(
			"expect(await kit.own('api.notes.editComment', { body: 'x', commentId: 'fabrika:row:note_comments', id: 'x' })).toEqual({ status: 200 })",
		)
	})

	test('a row of a table outside the object, a field that is no string, and an endpoint not on an owned object are findings', () => {
		expect(findings("export const rows = { 'api.notes.editComment': { commentId: 'workspaces', body: 'note_comments' } }\n")).toEqual([
			"api.notes.editComment: workspaces is no dimension or child table that lies directly in a note, so the kit seeds none in the endpoint's object (it seeds no container between)",
		])
		// A comment lies in a workspace through its note, a container the kit does not seed.
		expect(findings("export const rows = { 'api.workspaces.remove': { principalId: 'note_comments' } }\n")).toEqual([
			"api.workspaces.remove: note_comments is no dimension or child table that lies directly in a workspace, so the kit seeds none in the endpoint's object (it seeds no container between)",
		])
		expect(findings("export const rows = { 'api.workspaces.remove': { principalId: 'notes' } }\n")).toEqual([])
		expect(findings("export const rows = { 'api.notes.editComment': { missing: 'note_comments' } }\n")).toEqual([
			'api.notes.editComment: missing is no string field of its input, so it cannot name a row',
		])
		expect(findings("export const rows = { 'api.notes.create': { title: 'notes' } }\n")).toEqual([
			'api.notes.create is no tested endpoint on an object a table owns, in which the kit could seed a row',
		])
	})
})

describe('the application rows of the fixtures: rows of application tables an own case reads', () => {
	const ISOLATION_ROOT = join(import.meta.dir, '..', '..', '..', 'cli', 'src', '__tests__', 'fixtures', 'isolation-app')
	const withFixtures = (text: string) => new Map([...tree(ISOLATION_ROOT), [ENDPOINT_FIXTURES_FILE, text]])
	const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(withFixtures(text))).map((finding) => finding.message)

	test('the leak and own cases of an endpoint with application rows get them, after its seed', async () => {
		const text = await endpointTest(tree(ISOLATION_ROOT))
		expect(text).toContain("expect(await kit.own('shared.notice', {}, {}, { notices: { slug: 'welcome', published: true } })).toEqual({ status: 200 })")
		expect(text).toContain("expect(await kit.own('shared.note', {})).toEqual({ status: 200 })")
		const seeded = await endpointTest(
			withFixtures("export const seeds = { 'api.notes.rename': { pinned: true } }\nexport const appRows = { 'api.notes.rename': { notices: {} } }\n"),
		)
		const input = "{ expectVersion: 1, id: 'x', title: 'x' }"
		expect(seeded).toContain(`kit.own('api.notes.rename', ${input}, { pinned: true }, { notices: {} })`)
		expect(seeded).toContain(`kit.leaked('api.notes.rename', ${input}, { pinned: true }, { notices: {} })`)
		expect(seeded).toContain(`kit.leaked('api.notes.rename', ${input}, {}, { notices: {} })`)
		expect(seeded).toContain(`kit.denied('api.notes.rename', ${input}))`)
	})

	test('no application rows leave every other generated file as it was', async () => {
		const without = await endpointTest(withFixtures("export const rows = { 'api.notes.editComment': { commentId: 'note_comments' } }\n"))
		expect(without).toContain("expect(await kit.own('shared.notice', {})).toEqual({ status: 200 })")
		expect(without).not.toMatch(/kit\.own\([^)]*, \{\}, \{/)
	})

	test('a table that is no application table, a stamped column, and an endpoint whose handler no leak or own case runs, are findings', () => {
		expect(findings("export const appRows = { 'shared.notice': { notices: { published: true } } }\n")).toEqual([])
		// A read by the owner's read action has no own case, and a list no object, but both leak cases run the handler.
		expect(findings("export const appRows = { 'api.notes.get': { notices: {} }, 'api.notes.list': { notices: {} } }\n")).toEqual([])
		expect(findings("export const appRows = { 'shared.notice': { notes: { body: { x: 1 } }, countries: {}, missing: {} } }\n")).toEqual([
			'shared.notice: countries is a reference table, and an application row is seeded only in an application table (scope: { app })',
			'shared.notice: missing is no table of src/db/tables.ts, and an application row is seeded only in an application table (scope: { app })',
			'shared.notice: notes is a dimension table, and an application row is seeded only in an application table (scope: { app })',
		])
		// A create of a scope and an `in` write without sql run the handler in no leak or own case.
		expect(findings("export const appRows = { 'api.notes.create': { notices: {} }, 'api.organizations.create': { notices: {} } }\n")).toEqual([
			'api.notes.create is no endpoint with a leak or an own case, whose handler could read an application row the kit seeds',
			'api.organizations.create is no endpoint with a leak or an own case, whose handler could read an application row the kit seeds',
		])
		expect(findings("export const appRows = { 'shared.notice': { notices: { id: 'x', slug: 'welcome' } } }\n")).toEqual([
			"shared.notice: notices.id is the row's key, version or creator, which the seeding stamps",
		])
		expect(findings("export const appRows = { 'shared.notice': { constructor: {}, notices: { slug: ['a'], body: { x: 1 } } } }\n")).toEqual([
			'shared.notice: constructor is no table of src/db/tables.ts, and an application row is seeded only in an application table (scope: { app })',
			'shared.notice: notices.body is given an object, and a seeded column takes one value',
			'shared.notice: notices.slug is given an array, and a seeded column takes one value',
		])
		// A column the table does not have fails at the checker, not when the generated test runs.
		expect(findings("export const appRows = { 'shared.notice': { notices: { publshed: true, tags: ['a'] } } }\n")).toEqual([
			'shared.notice: notices.publshed is no column of notices',
			'shared.notice: notices.tags is no column of notices',
		])
	})

	test('each table of the application rows is an object of columns', () => {
		const read = (text: string) => scaffoldInputs(withFixtures(text)).fixtures.appRows
		expect(read("export const appRows = { 'shared.notice': { notices: { published: true } } }\n")).toEqual({
			'shared.notice': { notices: { published: true } },
		})
		expect(() => read("export const appRows = { 'shared.notice': { notices: true } }\n")).toThrow()
		expect(() => read("export const appRows = { 'shared.notice': 'notices' }\n")).toThrow()
	})
})

describe('the files of the fixtures: a file of the repository a case sends in a file field', () => {
	const FILES_ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'fixtures', 'kit-files')
	const withFixtures = (text: string) => new Map([...tree(FILES_ROOT), [ENDPOINT_FIXTURES_FILE, text]])
	const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(withFixtures(text))).map((finding) => finding.message)

	test("the kit of the generated test gets each file beside the test, and the cases keep the kind's marker", async () => {
		const text = await endpointTest(withFixtures("export const files = { 'api.notes.upload': { file: 'test/fixtures/document.pdf' } }\n"))
		expect(text).toContain(
			"const kit = endpointAccessKit(app, tables, postgres, { files: { 'api.notes.upload': { file: new URL('../../test/fixtures/document.pdf', import.meta.url) } } })",
		)
		expect(text).toContain("kit.own('api.notes.upload', { file: 'fabrika:file:documents', id: '00000000-0000-4000-8000-000000000000' })")
		expect(findings("export const files = { 'api.notes.upload': { file: 'test/fixtures/document.pdf' } }\n")).toEqual([])
	})

	test('no files leave the kit of the generated test as it was', async () => {
		expect(await endpointTest(tree(FILES_ROOT))).toContain('const kit = endpointAccessKit(app, tables, postgres)\n')
	})

	test('a file of no tested endpoint, of a field that holds no file, or outside the application is a finding, and is not written', async () => {
		expect(findings("export const files = { 'api.notes.missing': { file: 'a.pdf' } }\n")).toEqual([
			'api.notes.missing is no tested endpoint, whose cases could send a file',
		])
		expect(findings("export const files = { 'api.notes.upload': { id: 'a.pdf' } }\n")).toEqual([
			'api.notes.upload: id is no file field of its input, so no case sends a file there',
		])
		const outside = ['../secret.pdf', '/etc/passwd', 'test/./a.pdf', '.env', 'test/a.pdf?x', 'C:/a.pdf', 'test\\\\a.pdf', '']
		for (const path of outside) {
			const text = `export const files = { 'api.notes.upload': { file: '${path}' } }\n`
			expect(findings(text)).toEqual([`api.notes.upload: the file of file, '${path.replaceAll('\\\\', '\\')}', is no path inside the application`])
			expect(await endpointTest(withFixtures(text))).toContain('const kit = endpointAccessKit(app, tables, postgres)\n')
		}
	})

	test('the files are, by endpoint, objects of path strings', () => {
		const read = (text: string) => scaffoldInputs(withFixtures(text)).fixtures.files
		expect(read("export const files = { 'api.notes.upload': { file: 'a.pdf' } }\n")).toEqual({ 'api.notes.upload': { file: 'a.pdf' } })
		expect(() => read("export const files = { 'api.notes.upload': { file: 1 } }\n")).toThrow()
		expect(() => read("export const files = { 'api.notes.upload': 'a.pdf' }\n")).toThrow()
		expect(() => read('export const files = {}\nexport const files = {}\n')).toThrow()
	})
})

describe('the refusals of the fixtures: the 400s a handler may answer its own object with', () => {
	const FILES_ROOT = join(import.meta.dir, '..', '..', '..', 'app', 'src', '__tests__', 'fixtures', 'kit-files')
	const withFixtures = (text: string) => new Map([...tree(FILES_ROOT), [ENDPOINT_FIXTURES_FILE, text]])
	const findings = (text: string) => missingEndpointFixtures(scaffoldInputs(withFixtures(text))).map((finding) => finding.message)
	const INPUT = "{ file: 'fabrika:file:documents', id: '00000000-0000-4000-8000-000000000000' }"

	test('the kit gets them, the own case also admits their 400, and the denial and leak cases stay as they were', async () => {
		const text = await endpointTest(
			withFixtures(
				"export const files = { 'api.notes.upload': { file: 'test/document.pdf' } }\nexport const refusals = { 'api.notes.upload': ['document_invalid'] }\n",
			),
		)
		expect(text).toContain(
			"endpointAccessKit(app, tables, postgres, { files: { 'api.notes.upload': { file: new URL('../../test/document.pdf', import.meta.url) } }, refusals: { 'api.notes.upload': ['document_invalid'] } })",
		)
		expect(text).toContain(
			"test('api.notes.upload: a caller with only notes.write, notes.read, notes.write reaches its own note (200, or a refusal its fixtures declare)'",
		)
		expect(text).toContain(`expect([200, 400]).toContain((await kit.own('api.notes.upload', ${INPUT})).status)`)
		expect(text).toContain(`expect(await kit.denied('api.notes.upload', ${INPUT})).toEqual({ status: 404 })`)
		expect(text).toContain(`expect(await kit.leaked('api.notes.upload', ${INPUT})).toEqual({ answered: true, leaked: [] })`)
		expect(text).toContain(
			"expect(await kit.own('api.notes.attach', { file: 'fabrika:file:attachments', id: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 200 })",
		)
	})

	test("a refusal of no tested endpoint, or the input schema's own, is a finding and is not written", async () => {
		expect(findings("export const refusals = { 'api.notes.missing': ['document_invalid'] }\n")).toEqual([
			'api.notes.missing is no tested endpoint, whose handler a case runs',
		])
		const validation = "export const refusals = { 'api.notes.upload': ['validation'] }\n"
		expect(findings(validation)).toEqual([
			"api.notes.upload: 'validation' is no refusal of its handler; an input the schema refuses (validation) is the fixture's mistake",
		])
		expect(await endpointTest(withFixtures(validation))).toContain('const kit = endpointAccessKit(app, tables, postgres)\n')
	})

	test('the refusals are lists of error types, declared once', () => {
		const read = (text: string) => scaffoldInputs(withFixtures(text)).fixtures.refusals
		expect(read("export const refusals = { 'api.notes.upload': ['a', 'b'] }\n")).toEqual({ 'api.notes.upload': ['a', 'b'] })
		expect(() => read("export const refusals = { 'api.notes.upload': 'a' }\n")).toThrow()
		expect(() => read("export const refusals = { 'api.notes.upload': [] }\n")).toThrow()
		expect(() => read('export const refusals = {}\nexport const refusals = {}\n')).toThrow()
	})
})
