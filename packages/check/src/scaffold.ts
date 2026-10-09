// The tests `fabrika db test-scaffold` writes. Policy isolation tests, one file per table a store reaches, from the
// table policies alone: they prove the data layer enforces each policy, on a layer of their own. Endpoint access tests,
// one file per application, from the contract: they run the application's own `implement` and stores. The checker
// regenerates both to find a missing, edited, stale or orphaned file. Browser-safe: no file API.

import type { ContractArtifact, EndpointRow, TablePolicyArtifact } from '@fabrika/auth-core'
import { readContractSource, readTablesSource } from './contract'
import { CONTRACT_FILE, TABLES_FILE } from './layout'
import { generatedTestHeader } from './rules/tests'
import { renderSample, sample } from './scaffold-sample'

/** Where the generated policy isolation tests live, relative to the application root. */
export const POLICY_TESTS_DIR = 'src/db/__tests__/'
const POLICY_SUFFIX = '.policy-isolation.test.ts'

export const policyTestPath = (table: string): string => `${POLICY_TESTS_DIR}${table}${POLICY_SUFFIX}`

/** The generated endpoint access tests of the application; it imports `src/app.ts`, whose default export it boots. */
export const ENDPOINT_ACCESS_TEST = 'src/__tests__/endpoint-access.test.ts'

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
	const hidden = Object.keys(policy.columns).sort().map((column) =>
		testCase(`get leaves out ${column}, which has its own read action`, `expect((await kit.get('own')).columns).not.toContain(${quote(column)})`)
	)
	const blocks = [describeBlock(`policy of ${table}: a caller of one ${dimension} reaches no row of another`, isolation)]
	if (hidden.length > 0) blocks.push(describeBlock(`policy of ${table}: a column with its own read action is never returned`, hidden))
	const body = [
		`// The policy isolation tests of ${table}, written by fabrika db test-scaffold from src/db/tables.ts. They prove that`,
		"// the data layer enforces the policy, through a probe of their own: the application's handlers and stores do not run.",
		'// Do not edit: @fabrika/check compares this file with what the scaffold writes; rerun it after a policy change.',
		'',
		"import { policyIsolationKit } from '@fabrika/app/testing/isolation'",
		"import { testDatabase } from '@fabrika/db/testing'",
		"import { afterAll, describe, expect, test } from 'bun:test'",
		"import { contract } from '../../../fabrika.contract'",
		"import { tables } from '../tables'",
		'',
		`const label = ${quote(`${table}${POLICY_SUFFIX}`)}`,
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

/** One endpoint's cases: an object or a value of another scope is refused, and no answer holds another scope's rows. */
const endpointCases = (row: EndpointRow): { readonly cases: readonly Case[]; readonly skipped: string | null } => {
	if ((row.kind !== 'query' && row.kind !== 'mutation') || row.requirement === null || row.requirement.kind !== 'action') {
		return { cases: [], skipped: null }
	}
	if (!row.callers.some((caller) => caller === 'human' || caller === 'machine')) return { cases: [], skipped: null }
	const { access } = row.requirement
	if (access.form !== 'on' && access.form !== 'in' && access.form !== 'over') return { cases: [], skipped: null }
	const input = row.input === null ? {} : sample(row.input)
	if (input === undefined || input === null || typeof input !== 'object' || Array.isArray(input)) {
		return { cases: [], skipped: `${row.id}: no case, because the scaffold cannot write an input its schema admits` }
	}
	const literal = renderSample(input)
	const id = quote(row.id)
	const cases: Case[] = []
	if (access.form === 'on') {
		cases.push(
			testCase(`${row.id}: the ${access.dimension} of another scope is 404`, `expect(await kit.denied(${id}, ${literal})).toEqual({ status: 404 })`),
		)
	}
	if (access.form === 'in') {
		cases.push(
			testCase(`${row.id}: the ${access.dimension} of another scope is 403`, `expect(await kit.denied(${id}, ${literal})).toEqual({ status: 403 })`),
		)
	}
	if (access.form === 'on' || access.form === 'over') {
		cases.push(
			testCase(
				`${row.id}: the answer to one scope holds nothing of the scope answered before it`,
				`expect(await kit.leaked(${id}, ${literal})).toEqual({ status: 200, leaked: [] })`,
			),
		)
	}
	return { cases, skipped: null }
}

/** The endpoint access test of the application, or `undefined` when no endpoint has an access form to test. */
const endpointTestBody = (artifact: ContractArtifact): { readonly body: string; readonly cases: readonly string[] } | undefined => {
	const rows = [...artifact.endpoints].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).map(endpointCases)
	const cases = rows.flatMap((row) => row.cases)
	const skipped = rows.flatMap((row) => (row.skipped === null ? [] : [`// ${row.skipped}`]))
	if (cases.length === 0) return undefined
	const body = [
		'// The endpoint access tests of this application, written by fabrika db test-scaffold from fabrika.contract.ts and',
		'// src/db/tables.ts. They run src/app.ts itself: callers of two scopes that share no value ask every endpoint with an',
		'// access form. A handler bug that needs other data or another order is beyond them. Do not edit: @fabrika/check',
		'// compares this file with what the scaffold writes; rerun it after a contract or policy change.',
		...skipped,
		'',
		"import { endpointAccessKit } from '@fabrika/app/testing/isolation'",
		"import { testDatabase } from '@fabrika/db/testing'",
		"import { afterAll, describe, expect, test } from 'bun:test'",
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
export const generatedTests = async (policies: Policies, artifact: ContractArtifact | null): Promise<ReadonlyMap<string, GeneratedTest>> => {
	const files = new Map<string, GeneratedTest>()
	for (const table of Object.keys(policies).sort()) {
		const test = policyTestBody(policies, table)
		if (test !== undefined) files.set(policyTestPath(table), await generated(test))
	}
	const endpoints = artifact === null || files.size === 0 ? undefined : endpointTestBody(artifact)
	if (endpoints !== undefined) files.set(ENDPOINT_ACCESS_TEST, await generated(endpoints))
	return files
}

/** What the scaffold reads from an application's files; throws `ContractSourceError` or `ContractError` as the reader does. */
export const scaffoldInputs = (files: ReadonlyMap<string, string>): { readonly policies: Policies; readonly artifact: ContractArtifact | null } => {
	const policies = readTablesSource(files)
	// Endpoint tests seed rows from the policies, so without src/db/tables.ts there is nothing to compile them against.
	return { policies, artifact: files.has(CONTRACT_FILE) && files.has(TABLES_FILE) ? readContractSource(files, policies) : null }
}
