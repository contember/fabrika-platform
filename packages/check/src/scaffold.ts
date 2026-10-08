// The isolation tests `fabrika db test-scaffold` writes, one file per table a store reaches, from the table policies
// alone. The checker regenerates them to find a missing, stale or orphaned one; the header hash finds an edited one.
// Browser-safe: no file API.

import type { TablePolicyArtifact } from '@fabrika/auth-core'
import { generatedTestHeader } from './rules/tests'

/** Where the generated isolation tests live, relative to the application root. */
export const ISOLATION_TESTS_DIR = 'src/db/__tests__/'
const ISOLATION_SUFFIX = '.isolation.test.ts'

export const isolationTestPath = (table: string): string => `${ISOLATION_TESTS_DIR}${table}${ISOLATION_SUFFIX}`

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

/** The body of `table`'s isolation test (everything after the header), or `undefined` for a table no store reaches. */
export const isolationTestBody = (policies: Policies, table: string): string | undefined => {
	const policy = policies[table]
	if (policy === undefined) return undefined
	const dimension = grantDimension(policies, policy)
	if (dimension === undefined) return undefined
	const blocks = [describeBlock(`${table}: a caller of one ${dimension} reaches no row of another`, isolationCases(policy, dimension))]
	const hidden = Object.keys(policy.columns).sort()
	if (hidden.length > 0) {
		blocks.push(describeBlock(
			`${table}: a column with its own read action is never returned`,
			hidden.map((column) => testCase(`get leaves out ${column}`, `expect((await kit.get('own')).columns).not.toContain(${quote(column)})`)),
		))
	}
	return [
		`// The isolation tests of ${table}, written by fabrika db test-scaffold from its policy in src/db/tables.ts. Do not`,
		'// edit: @fabrika/check verifies this file against its hash and the policy; rerun the scaffold after a policy change.',
		'',
		"import { isolationKit } from '@fabrika/app/testing/isolation'",
		"import { testDatabase } from '@fabrika/db/testing'",
		"import { afterAll, describe, expect, test } from 'bun:test'",
		"import { contract } from '../../../fabrika.contract'",
		"import { tables } from '../tables'",
		'',
		`const label = ${quote(`${table}${ISOLATION_SUFFIX}`)}`,
		"const postgres = await testDatabase({ migrations: new URL('../../../db/migrations/', import.meta.url), label })",
		'',
		'if (postgres !== null) {',
		'\tafterAll(() => postgres.close())',
		`\tconst kit = isolationKit(contract, tables, ${quote(table)}, postgres)`,
		'',
		blocks.join('\n\n'),
		'}',
		'',
	].join('\n')
}

/** Every isolation test the policies call for, by path, as `fabrika db test-scaffold` writes it (header included). */
export const isolationTests = async (policies: Policies): Promise<ReadonlyMap<string, string>> => {
	const files = new Map<string, string>()
	for (const table of Object.keys(policies).sort()) {
		const body = isolationTestBody(policies, table)
		if (body !== undefined) files.set(isolationTestPath(table), `${await generatedTestHeader(body)}\n${body}`)
	}
	return files
}
