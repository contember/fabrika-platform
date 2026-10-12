// The tests `fabrika db test-scaffold` writes. Policy isolation tests, one file per table a store reaches, from the
// table policies alone: they prove the data layer enforces each policy, on a layer of their own. Endpoint access tests,
// one file per application, from the contract: they run the application's own `serve(…)` and handlers. The checker
// regenerates both to find a missing, edited, stale or orphaned file. Browser-safe: no file API.

import type { ContractArtifact, EndpointRow, TablePolicyArtifact } from '@fabrika/auth-core'
import { ContractSourceError, readContractSource, readTablesSource } from './contract'
import { type EndpointFixtures, isSampleObject, NO_FIXTURES, readEndpointFixtures } from './endpoint-fixtures'
import type { Finding } from './finding'
import { CONTRACT_FILE, ENDPOINT_ACCESS_TEST, ENDPOINT_FIXTURES_FILE, POLICY_TEST_SUFFIX, POLICY_TESTS_DIR, TABLES_FILE } from './layout'

export { ENDPOINT_ACCESS_TEST, ENDPOINT_FIXTURES_FILE, POLICY_TEST_SUFFIX, POLICY_TESTS_DIR } from './layout'
import { generatedTestHeader } from './rules/tests'
import { renderSample, type Sample, sample } from './scaffold-sample'

export const policyTestPath = (table: string): string => `${POLICY_TESTS_DIR}${table}${POLICY_TEST_SUFFIX}`

/** One generated test file: its full text, header included, and the name of every test case it registers. */
export interface GeneratedTest {
	readonly text: string
	readonly cases: readonly string[]
}

type Policies = Readonly<Record<string, TablePolicyArtifact>>

interface Case {
	readonly name: string
	readonly lines: readonly string[]
}

const testCase = (name: string, ...lines: readonly string[]): Case => ({ name, lines })

const quote = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const renderCase = (item: Case): string =>
	[`\t\ttest(${quote(item.name)}, async () => {`, ...item.lines.map((line) => `\t\t\t${line}`), '\t\t})'].join('\n')

/** The dimension a caller's grants are scoped by: the container of a dimension table, or its own; a child's parent's. */
const grantDimension = (policies: Policies, policy: TablePolicyArtifact): string | undefined => {
	const scope = policy.scope
	if (scope.mode === 'dimension') return scope.container?.dimension ?? scope.dimension
	if (scope.mode !== 'child') return undefined
	const parent = policies[scope.parent]?.scope
	return parent?.mode === 'dimension' ? (parent.container?.dimension ?? parent.dimension) : undefined
}

const isolationCases = (policy: TablePolicyArtifact, dimension: string): readonly Case[] => {
	const { actions, scope } = policy
	const child = scope.mode === 'child'
	const contained = scope.mode === 'child' || (scope.mode === 'dimension' && scope.container !== null)
	const other = `another ${dimension}`
	const writes = policy.update.length > 0 || policy.version !== null
	const cases: Case[] = [
		testCase('get answers its own row', "expect((await kit.get('own')).status).toBe(200)"),
		testCase(`get of a row in ${other} is 404`, "expect((await kit.get('other')).status).toBe(404)"),
	]
	if (child) {
		cases.push(testCase(`get of a key in ${other} through its own parent is 404`, "expect((await kit.get('crossed')).status).toBe(404)"))
		cases.push(
			testCase('a list by its own parent reaches only its own row', "expect(await kit.listByParent('own')).toEqual({ status: 200, rows: ['own'] })"),
		)
		cases.push(testCase(`a list by a parent in ${other} is 404`, "expect((await kit.listByParent('other')).status).toBe(404)"))
	}
	cases.push(testCase('a list reaches only its own row', "expect(await kit.list()).toEqual({ status: 200, rows: ['own'] })"))
	cases.push(testCase('a count counts only its own row', "expect(await kit.count()).toEqual({ status: 200, count: '1' })"))
	if (actions.insert !== null) {
		if (contained) cases.push(testCase(`insert into its own ${dimension} succeeds`, "expect((await kit.insert('own')).status).toBe(200)"))
		cases.push(testCase(`insert into ${other} is 403`, "expect((await kit.insert('other')).status).toBe(403)"))
	}
	if (actions.update !== null) {
		if (writes) cases.push(testCase('update of its own row succeeds', "expect((await kit.update('own')).status).toBe(200)"))
		cases.push(testCase(`update of a row in ${other} is 404`, "expect((await kit.update('other')).status).toBe(404)"))
		if (child) {
			cases.push(testCase(`update of a key in ${other} through its own parent is 404`, "expect((await kit.update('crossed')).status).toBe(404)"))
		}
		if (actions.update !== actions.read) {
			cases.push(testCase(`update refuses a Ref for ${actions.read}`, 'expect(await kit.updateWithRead()).toEqual({ status: 200, refused: true })'))
		}
	}
	if (actions.delete !== null) {
		cases.push(testCase('remove of its own row succeeds', "expect((await kit.remove('own')).status).toBe(200)"))
		cases.push(testCase(`remove of a row in ${other} is 404`, "expect((await kit.remove('other')).status).toBe(404)"))
		if (child) {
			cases.push(testCase(`remove of a key in ${other} through its own parent is 404`, "expect((await kit.remove('crossed')).status).toBe(404)"))
		}
		if (actions.delete !== actions.read) {
			cases.push(testCase(`remove refuses a Ref for ${actions.read}`, 'expect(await kit.removeWithRead()).toEqual({ status: 200, refused: true })'))
		}
	}
	return cases
}

const describeBlock = (title: string, cases: readonly Case[]): string =>
	[`\tdescribe(${quote(title)}, () => {`, cases.map(renderCase).join('\n\n'), '\t})'].join('\n')

/** `table`'s policy isolation test (everything after the header), or `undefined` for a table no store reaches. */
const policyTestBody = (policies: Policies, table: string): { readonly body: string; readonly cases: readonly string[] } | undefined => {
	const policy = policies[table]
	if (policy === undefined) return undefined
	const dimension = grantDimension(policies, policy)
	if (dimension === undefined) return undefined
	const isolation = isolationCases(policy, dimension)
	// A column with only its own write action is read by the table's read action, so it is returned like any other.
	const hidden = Object.keys(policy.columns).filter((column) => policy.columns[column]?.read !== undefined).sort().map((column) =>
		testCase(`get leaves out ${column}, which has its own read action`, `expect((await kit.get('own')).columns).not.toContain(${quote(column)})`)
	)
	const blocks = [describeBlock(`policy of ${table}: a caller of one ${dimension} reaches no row of another`, isolation)]
	if (hidden.length > 0) blocks.push(describeBlock(`policy of ${table}: a column with its own read action is never returned`, hidden))
	const body = [
		`// The policy isolation tests of ${table}, written by fabrika db test-scaffold from src/db/tables.ts. They prove that`,
		"// the data layer enforces the policy, through a probe of their own: the application's handlers and stores do not run.",
		'// Do not edit: @fabrika/check compares this file with what the scaffold writes; rerun it after a policy change.',
		'',
		"import { afterAll, describe, expect, policyIsolationKit, test } from '@fabrika/app/testing/isolation'",
		"import { testDatabase } from '@fabrika/db/testing'",
		"import { contract } from '../../../fabrika.contract'",
		"import { tables } from '../tables'",
		'',
		`const label = ${quote(`${table}${POLICY_TEST_SUFFIX}`)}`,
		"const postgres = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label })",
		'',
		'if (postgres !== null) {',
		'\tafterAll(() => postgres.close())',
		`\tconst kit = policyIsolationKit(contract, tables, ${quote(table)}, postgres)`,
		'',
		blocks.join('\n\n'),
		'}',
		'',
	].join('\n')
	return { body, cases: [...isolation, ...hidden].map((item) => item.name) }
}

/** Whether an endpoint gets endpoint access cases: a procedure with an `on`, `in` or `over` access form, for a person or a machine. */
const isAccessTested = (row: EndpointRow): boolean => {
	if ((row.kind !== 'query' && row.kind !== 'mutation') || row.requirement === null || row.requirement.kind !== 'action') return false
	const { form } = row.requirement.access
	return row.callers.some((caller) => caller === 'human' || caller === 'machine') && (form === 'on' || form === 'in' || form === 'over')
}

/** Whether an endpoint is a procedure of a link mount: its link holder reaches the object the key is bound to. */
const isLinkProcedure = (row: EndpointRow): boolean =>
	(row.kind === 'query' || row.kind === 'mutation') && row.requirement?.kind === 'action' && row.callers.some((caller) => caller === 'link')

/** The input an endpoint's cases send: the author's fixture, else a sample of its schema; `undefined` when neither exists. */
const inputOf = (row: EndpointRow, fixtures: EndpointFixtures): Readonly<Record<string, Sample>> | undefined => {
	const fixture = fixtures.inputs[row.id]
	if (fixture !== undefined) return fixture
	const input = row.input === null ? {} : sample(row.input)
	return input !== undefined && isSampleObject(input) ? input : undefined
}

/** The read action of the table that owns `dimension`, or `undefined` when no table owns it. */
const ownerRead = (policies: Policies, dimension: string): string | undefined =>
	Object.values(policies).find((policy) => policy.scope.mode === 'dimension' && policy.scope.dimension === dimension)?.actions.read

/**
 * One endpoint's cases: an object or a value of another scope is refused; no answer holds another scope's rows unless
 * the endpoint declares `unscoped` (it reaches across scopes by design); a write action reads its own target.
 */
const endpointCases = (row: EndpointRow, artifact: ContractArtifact, policies: Policies, fixtures: EndpointFixtures): readonly Case[] => {
	const linked = isLinkProcedure(row)
	if ((!isAccessTested(row) && !linked) || row.requirement === null || row.requirement.kind !== 'action') return []
	const { access, action } = row.requirement
	const input = inputOf(row, fixtures)
	if (input === undefined) return []
	const seed = fixtures.seeds[row.id]
	const args = `${quote(row.id)}, ${renderSample(input)}`
	const seeded = seed === undefined ? args : `${args}, ${renderSample(seed)}`
	const declared = artifact.declared?.[row.id]
	const unscoped = declared !== undefined && Object.keys(declared.unscoped).length > 0
	const read = access.form === 'on' ? ownerRead(policies, access.dimension) : undefined
	const own = read !== undefined && (linked || read !== action)
	const cases: Case[] = []
	// The unseeded probe always runs: a seed meets a precondition, and must not also set aside the state that leaks.
	const leaked = (): Case[] => [
		testCase(
			`${row.id}: the answer to one scope holds nothing of the scope answered before it`,
			`expect(await kit.leaked(${args})).toEqual({ answered: true, leaked: [] })`,
		),
		...(seed === undefined ? [] : [
			testCase(
				`${row.id}: with its seed, the answer to one scope holds nothing of the scope answered before it`,
				`expect(await kit.leaked(${seeded})).toEqual({ answered: true, leaked: [] })`,
			),
		]),
	]
	if (linked) {
		if (own) {
			cases.push(
				testCase(`${row.id}: the holder of a link to a ${access.dimension} reaches it`, `expect(await kit.own(${seeded})).toEqual({ status: 200 })`),
			)
		}
		return cases
	}
	if (access.form === 'on') {
		cases.push(testCase(`${row.id}: the ${access.dimension} of another scope is 404`, `expect(await kit.denied(${args})).toEqual({ status: 404 })`))
		if (!unscoped) cases.push(...leaked())
		if (own) {
			cases.push(
				testCase(
					`${row.id}: a caller with only ${action} reaches its own ${access.dimension}`,
					`expect(await kit.own(${seeded})).toEqual({ status: 200 })`,
				),
			)
		}
	}
	if (access.form === 'in') {
		cases.push(testCase(`${row.id}: the ${access.dimension} of another scope is 403`, `expect(await kit.denied(${args})).toEqual({ status: 403 })`))
		if (declared !== undefined && declared.sql !== null && !unscoped) cases.push(...leaked())
	}
	if (access.form === 'over' && !unscoped) cases.push(...leaked())
	return cases
}

/**
 * A file endpoint's own cases, over a file the kit seeds in each scope. Their names carry the collection's actions, so a
 * change of one makes the committed test stale; a read action that also writes or removes loses its refusal case.
 */
const fileCases = (row: EndpointRow, artifact: ContractArtifact): readonly Case[] => {
	if (row.source.kind !== 'files') return []
	const name = row.source.name
	const collection = artifact.files[name]
	if (collection === undefined) return []
	const call = (operation: string, caller: string, status: number) =>
		`expect(await kit.file(${quote(name)}, ${quote(operation)}, ${quote(caller)})).toEqual({ status: ${status} })`
	const owner = `${collection.owner} row`
	if (row.kind === 'upload') {
		return [
			testCase(`${row.id}: a caller with ${collection.write} uploads to an own ${owner}`, call('upload', 'own', 200)),
			testCase(`${row.id}: the ${owner} of another scope is 404`, call('upload', 'other', 404)),
			...(collection.write === collection.read ? [] : [
				testCase(`${row.id}: a caller with only ${collection.read} cannot upload`, call('upload', 'reader', 403)),
			]),
		]
	}
	if (row.kind === 'download') {
		return [
			testCase(`${row.id}: a caller with ${collection.read} downloads an own file`, call('download', 'own', 200)),
			testCase(`${row.id}: a file of another scope is 404`, call('download', 'other', 404)),
		]
	}
	return [
		testCase(`${row.id}: a caller with ${collection.delete} removes an own file`, call('remove', 'own', 200)),
		...(collection.delete === collection.read ? [] : [
			testCase(`${row.id}: a caller with only ${collection.read} cannot remove`, call('remove', 'reader', 403)),
		]),
	]
}

/** The endpoint access test of the application, or `undefined` when no endpoint has an access form to test. */
const endpointTestBody = (
	artifact: ContractArtifact,
	policies: Policies,
	fixtures: EndpointFixtures,
): { readonly body: string; readonly cases: readonly string[] } | undefined => {
	const cases = [...artifact.endpoints].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).flatMap((
		row,
	) => [...endpointCases(row, artifact, policies, fixtures), ...fileCases(row, artifact)])
	if (cases.length === 0) return undefined
	const body = [
		'// The endpoint access tests of this application, written by fabrika db test-scaffold from fabrika.contract.ts and',
		'// src/db/tables.ts. They run src/app.ts itself: callers of two scopes that share no value ask every endpoint with an',
		"// access form, and a caller with only the endpoint's action asks for its own object. A handler bug that needs other",
		'// data or another order is beyond them; the state a precondition needs is a seed in endpoint-access.fixtures.ts.',
		'// Do not edit: @fabrika/check compares this file with what the scaffold writes; rerun it after a contract change.',
		'',
		"import { afterAll, describe, endpointAccessKit, expect, test } from '@fabrika/app/testing/isolation'",
		"import { testDatabase } from '@fabrika/db/testing'",
		"import app from '../app'",
		"import { tables } from '../db/tables'",
		'',
		"const label = 'endpoint-access.test.ts'",
		"const postgres = await testDatabase({ migrations: new URL('../../db/migrations/', import.meta.url), label })",
		'',
		'if (postgres !== null) {',
		'\tafterAll(() => postgres.close())',
		'\tconst kit = endpointAccessKit(app, tables, postgres)',
		'',
		describeBlock('endpoints: a caller of one scope reaches nothing of another', cases),
		'}',
		'',
	].join('\n')
	return { body, cases: cases.map((item) => item.name) }
}

const generated = async ({ body, cases }: { readonly body: string; readonly cases: readonly string[] }): Promise<GeneratedTest> => ({
	text: `${await generatedTestHeader(body)}\n${body}`,
	cases,
})

/**
 * Every test the scaffold writes for these policies and, when the application has a contract, its artifact; by path.
 * Endpoint access tests exist only for an application on `@fabrika/db`, which has policies to seed rows from.
 */
export const generatedTests = async (
	policies: Policies,
	artifact: ContractArtifact | null,
	fixtures: EndpointFixtures = NO_FIXTURES,
): Promise<ReadonlyMap<string, GeneratedTest>> => {
	const files = new Map<string, GeneratedTest>()
	for (const table of Object.keys(policies).sort()) {
		const test = policyTestBody(policies, table)
		if (test !== undefined) files.set(policyTestPath(table), await generated(test))
	}
	const endpoints = artifact === null || files.size === 0 ? undefined : endpointTestBody(artifact, policies, fixtures)
	if (endpoints !== undefined) files.set(ENDPOINT_ACCESS_TEST, await generated(endpoints))
	return files
}

export interface ScaffoldInputs {
	readonly policies: Policies
	readonly artifact: ContractArtifact | null
	readonly fixtures: EndpointFixtures
}

/** What the scaffold reads from an application's files; throws `ContractSourceError` or `ContractError` as the reader does. */
export const scaffoldInputs = (files: ReadonlyMap<string, string>): ScaffoldInputs => {
	const policies = readTablesSource(files)
	const fixtures = readEndpointFixtures(files)
	if (!fixtures.ok) throw new ContractSourceError(fixtures.findings)
	// Endpoint tests seed rows from the policies, so without src/db/tables.ts there is nothing to compile them against.
	const artifact = files.has(CONTRACT_FILE) && files.has(TABLES_FILE) ? readContractSource(files, policies) : null
	return { policies, artifact, fixtures: fixtures.fixtures }
}

/**
 * What stops the endpoint access tests from covering every endpoint: one whose input the scaffold cannot sample and
 * the author gave no fixture, and a fixture of no tested endpoint. Each is an `endpoint-fixture` finding.
 */
export const missingEndpointFixtures = ({ policies, artifact, fixtures }: ScaffoldInputs): readonly Finding[] => {
	if (artifact === null || Object.keys(policies).length === 0) return []
	const at = (message: string, allowed: string): Finding => ({
		file: ENDPOINT_FIXTURES_FILE,
		line: 1,
		column: 1,
		severity: 'refusal',
		rule: 'endpoint-fixture',
		message,
		allowed,
	})
	const tested = artifact.endpoints.filter((row) => isAccessTested(row) || isLinkProcedure(row))
	const findings = tested.filter((row) => inputOf(row, fixtures) === undefined).map((row) =>
		at(
			`${row.id}: the scaffold cannot write an input its schema admits, so its endpoint access cases need one here`,
			`export const fixtures = { '${row.id}': { … } }, an input the endpoint's schema admits`,
		)
	)
	for (const id of Object.keys(fixtures.inputs).sort()) {
		if (!tested.some((row) => row.id === id)) {
			findings.push(at(`${id} is no endpoint with an on, in or over access form`, 'a fixture of a tested endpoint, or none'))
		}
	}
	const seeded = (row: EndpointRow): boolean =>
		row.requirement?.kind === 'action' && (row.requirement.access.form === 'on' || row.requirement.access.form === 'in')
	for (const id of Object.keys(fixtures.seeds).sort()) {
		if (!tested.some((row) => row.id === id && seeded(row))) {
			findings.push(
				at(`${id} is no endpoint with an on or in access form, whose row a seed sets`, "export const seeds = { '<endpoint id>': { <column>: <value> } }"),
			)
		}
	}
	return findings
}
