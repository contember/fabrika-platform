// The tests `fabrika db test-scaffold` writes. Policy isolation tests, one file per table a store reaches, from the
// table policies alone: they prove the data layer enforces each policy, on a layer of their own. Endpoint access tests,
// one file per application, from the contract: they run the application's own `serve(…)` and handlers. The checker
// regenerates both to find a missing, edited, stale or orphaned file. Browser-safe: no file API.

import { GENERATED_INVITATION, GENERATED_LINK, GENERATED_MEMBER, GENERATED_ROW_PREFIX } from '@fabrika/app/contract'
import {
	type ContractArtifact,
	endpointDirectory,
	endpointMembers,
	type EndpointRow,
	type SchemaShape,
	tableActions,
	type TablePolicyArtifact,
} from '@fabrika/auth-core'
import { tablePolicies } from '@fabrika/db/tables'
import { ContractSourceError, readContractSource, readTablesDefinition } from './contract'
import { type ApplicationDialect, applicationDialect } from './dialect'
import { type EndpointFixtures, isSampleObject, NO_FIXTURES, readEndpointFixtures } from './endpoint-fixtures'
import type { Finding } from './finding'
import { CONTRACT_FILE, ENDPOINT_ACCESS_TEST, ENDPOINT_FIXTURES_FILE, POLICY_TEST_SUFFIX, POLICY_TESTS_DIR } from './layout'

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

/** The test database kit of each dialect, and the name a generated test gives the database it opens. */
const TEST_KITS: Readonly<Record<ApplicationDialect, { readonly module: string; readonly name: string }>> = {
	postgres: { module: '@fabrika/db/testing', name: 'postgres' },
	sqlite: { module: '@fabrika/db/testing-sqlite', name: 'database' },
}

/** The lines of a generated test that open its database: the kit's import and the call, against `migrations`. */
const testDatabaseLines = (
	dialect: ApplicationDialect,
	migrations: string,
): { readonly kit: string; readonly open: string; readonly name: string } => {
	const { module, name } = TEST_KITS[dialect]
	return {
		kit: `import { testDatabase } from '${module}'`,
		open: `const ${name} = await testDatabase({ migrations: new URL('${migrations}', import.meta.url), label })`,
		name,
	}
}

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

/**
 * The actions the generated cases probe: the first of each operation, whose kit endpoint holds it. A refusal case runs
 * only where the probed read action is not also an action of the operation it is refused.
 */
interface ProbedActions {
	readonly read: string
	readonly insert: string | null
	readonly update: string | null
	readonly delete: string | null
	readonly updateRefusesRead: boolean
	readonly deleteRefusesRead: boolean
	readonly appRead?: readonly string[]
	readonly appCount?: readonly string[]
}

const probedActions = (actions: TablePolicyArtifact['actions']): ProbedActions => {
	const read = tableActions(actions.read)[0] ?? ''
	return {
		read,
		insert: tableActions(actions.insert)[0] ?? null,
		update: tableActions(actions.update)[0] ?? null,
		delete: tableActions(actions.delete)[0] ?? null,
		updateRefusesRead: !tableActions(actions.update).includes(read),
		deleteRefusesRead: !tableActions(actions.delete).includes(read),
		...(actions.appRead === undefined ? {} : { appRead: actions.appRead }),
		...(actions.appCount === undefined ? {} : { appCount: actions.appCount }),
	}
}

const isolationCases = (policy: TablePolicyArtifact, dimension: string): readonly Case[] => {
	const { scope } = policy
	const actions = probedActions(policy.actions)
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
		if (actions.updateRefusesRead) {
			cases.push(testCase(`update refuses a Ref for ${actions.read}`, 'expect(await kit.updateWithRead()).toEqual({ status: 200, refused: true })'))
		}
	}
	if (actions.delete !== null) {
		cases.push(testCase('remove of its own row succeeds', "expect((await kit.remove('own')).status).toBe(200)"))
		cases.push(testCase(`remove of a row in ${other} is 404`, "expect((await kit.remove('other')).status).toBe(404)"))
		if (child) {
			cases.push(testCase(`remove of a key in ${other} through its own parent is 404`, "expect((await kit.remove('crossed')).status).toBe(404)"))
		}
		if (actions.deleteRefusesRead) {
			cases.push(testCase(`remove refuses a Ref for ${actions.read}`, 'expect(await kit.removeWithRead()).toEqual({ status: 200, refused: true })'))
		}
	}
	for (const action of actions.appRead ?? []) {
		cases.push(
			testCase(
				`an app endpoint of ${action} lists every row`,
				`expect(await kit.appList(${quote(action)})).toEqual({ status: 200, rows: ['own', 'other'] })`,
			),
			testCase(
				`an app endpoint of ${action} reads the columns of its own action`,
				`expect(await kit.appColumns(${quote(action)})).toEqual({ status: 200, leaked: [], missing: [] })`,
			),
		)
	}
	for (const action of actions.appCount ?? []) {
		cases.push(
			testCase(`an app endpoint of ${action} counts every row`, `expect(await kit.appCount(${quote(action)})).toEqual({ status: 200, counted: 2 })`),
			testCase(
				`an app endpoint of ${action} lists no row`,
				`expect(await kit.appListWithCount(${quote(action)})).toEqual({ status: 200, refused: true })`,
			),
			testCase(
				`an app endpoint of ${action} groups no row`,
				`expect(await kit.appGroupWithCount(${quote(action)})).toEqual({ status: 200, refused: true })`,
			),
		)
	}
	return cases
}

/**
 * An application table's cases: its rows lie in no scope, so the boundary is the grant. A holder of the table's actions
 * as global grants reaches each operation; a holder of the same actions in one scope only is refused by the proxy. Where
 * the vocabulary has a dimension, a scoped site of the read action reads every row, and one of another action none.
 */
const appIsolationCases = (policy: TablePolicyArtifact, scopedSites: boolean): readonly Case[] => {
	const actions = probedActions(policy.actions)
	const writes = policy.update.length > 0 || policy.version !== null
	const pair = (operation: string, call: string, done: string): Case[] => [
		testCase(`${operation} by a global holder succeeds`, `expect(${call.replace('CALLER', "'global'")}).${done}`),
		testCase(`${operation} by a holder in one scope only is 403`, `expect((${call.replace('CALLER', "'scoped'")}).status).toBe(403)`),
	]
	const cases: Case[] = [
		...pair('get', 'await kit.get(CALLER)', 'toMatchObject({ status: 200 })'),
		...pair('a list', 'await kit.list(CALLER)', "toEqual({ status: 200, rows: ['own'] })"),
	]
	if (actions.insert !== null) cases.push(...pair('insert', 'await kit.insert(CALLER)', 'toEqual({ status: 200 })'))
	if (actions.update !== null) {
		if (writes) cases.push(...pair('update', 'await kit.update(CALLER)', 'toEqual({ status: 200 })'))
		if (actions.updateRefusesRead) {
			cases.push(
				testCase(`update refuses a capability of ${actions.read}`, 'expect(await kit.updateWithRead()).toEqual({ status: 200, refused: true })'),
			)
		}
	}
	if (actions.delete !== null) {
		cases.push(...pair('remove', 'await kit.remove(CALLER)', 'toEqual({ status: 200 })'))
		if (actions.deleteRefusesRead) {
			cases.push(
				testCase(`remove refuses a capability of ${actions.read}`, 'expect(await kit.removeWithRead()).toEqual({ status: 200, refused: true })'),
			)
		}
	}
	if (scopedSites) {
		cases.push(testCase(`a scoped site of ${actions.read} reads every row`, "expect(await kit.scopedList()).toEqual({ status: 200, rows: ['own'] })"))
		const reads = tableActions(policy.actions.read)
		const other = [actions.insert, actions.update, actions.delete].find((action) => action !== null && !reads.includes(action))
		if (other !== undefined) {
			cases.push(
				testCase(`a scoped site of ${other} reads no row`, 'expect(await kit.scopedListWithOther()).toEqual({ status: 200, refused: true })'),
			)
		}
	}
	return cases
}

const describeBlock = (title: string, cases: readonly Case[]): string =>
	[`\tdescribe(${quote(title)}, () => {`, cases.map(renderCase).join('\n\n'), '\t})'].join('\n')

/** `table`'s policy isolation test (everything after the header), or `undefined` for a table no store reaches. */
const policyTestBody = (
	policies: Policies,
	table: string,
	scopedSites: boolean,
	dialect: ApplicationDialect,
): { readonly body: string; readonly cases: readonly string[] } | undefined => {
	const policy = policies[table]
	if (policy === undefined) return undefined
	const app = policy.scope.mode === 'app'
	const dimension = grantDimension(policies, policy)
	if (dimension === undefined && !app) return undefined
	const isolation = dimension === undefined ? appIsolationCases(policy, scopedSites) : isolationCases(policy, dimension)
	const own = app ? "'global'" : "'own'"
	// A column with only its own write action is read by the table's read action, so it is returned like any other.
	const hidden = Object.keys(policy.columns).filter((column) => policy.columns[column]?.read !== undefined).sort().map((column) =>
		testCase(`get leaves out ${column}, which has its own read action`, `expect((await kit.get(${own})).columns).not.toContain(${quote(column)})`)
	)
	const title = dimension === undefined
		? `policy of ${table}: only a global holder of its actions reaches a row`
		: `policy of ${table}: a caller of one ${dimension} reaches no row of another`
	const kitOf = app ? 'appPolicyIsolationKit' : 'policyIsolationKit'
	const database = testDatabaseLines(dialect, '../../../db/migrations/')
	const blocks = [describeBlock(title, isolation)]
	if (hidden.length > 0) blocks.push(describeBlock(`policy of ${table}: a column with its own read action is never returned`, hidden))
	const body = [
		`// The policy isolation tests of ${table}, written by fabrika db test-scaffold from src/db/tables.ts. They prove that`,
		"// the data layer enforces the policy, through a probe of their own: the application's handlers and stores do not run.",
		'// Do not edit: @fabrika/check compares this file with what the scaffold writes; rerun it after a policy change.',
		'',
		`import { ${['afterAll', 'describe', 'expect', kitOf, 'test'].sort().join(', ')} } from '@fabrika/app/testing/isolation'`,
		database.kit,
		"import { contract } from '../../../fabrika.contract'",
		"import { tables } from '../tables'",
		'',
		`const label = ${quote(`${table}${POLICY_TEST_SUFFIX}`)}`,
		database.open,
		'',
		`if (${database.name} !== null) {`,
		`\tafterAll(() => ${database.name}.close())`,
		`\tconst kit = ${kitOf}(contract, tables, ${quote(table)}, ${database.name})`,
		'',
		blocks.join('\n\n'),
		'}',
		'',
	].join('\n')
	return { body, cases: [...isolation, ...hidden].map((item) => item.name) }
}

/** Whether an endpoint gets endpoint access cases: a procedure with an access form or several, for a person or a machine. */
const isAccessTested = (row: EndpointRow): boolean => {
	if ((row.kind !== 'query' && row.kind !== 'mutation') || row.requirement === null || row.requirement.kind === 'member') return false
	return row.callers.some((caller) => caller === 'human' || caller === 'machine')
}

/** Whether an endpoint is a procedure of a link mount: its link holder reaches the object the key is bound to. */
const isLinkProcedure = (row: EndpointRow): boolean =>
	(row.kind === 'query' || row.kind === 'mutation') && row.requirement?.kind === 'action' && row.callers.some((caller) => caller === 'link')

/**
 * The input an endpoint's cases send: the author's fixture, else a sample of its schema; `undefined` when neither
 * exists. Each field its `members`, `invitations` or `links` name holds `GENERATED_MEMBER`, `GENERATED_INVITATION` or
 * `GENERATED_LINK`, which the kit replaces with a real member, an open invitation or a link it issued; each field its
 * `rows` name holds `GENERATED_ROW_PREFIX` and the table, which the kit replaces with the key of a row it seeded.
 */
const inputOf = (row: EndpointRow, fixtures: EndpointFixtures): Readonly<Record<string, Sample>> | undefined => {
	const fixture = fixtures.inputs[row.id]
	const input = fixture ?? (row.input === null ? {} : sample(row.input))
	if (input === undefined || !isSampleObject(input)) return undefined
	const generated = (fields: readonly string[] | undefined, marker: string) => (fields ?? []).map((field) => [field, marker])
	return {
		...input,
		...Object.fromEntries([
			...generated(fixtures.members[row.id], GENERATED_MEMBER),
			...generated(fixtures.invitations[row.id], GENERATED_INVITATION),
			...generated(fixtures.links[row.id], GENERATED_LINK),
			...Object.entries(fixtures.rows[row.id] ?? {}).map(([field, table]) => [field, `${GENERATED_ROW_PREFIX}${table}`]),
		]),
	}
}

/** Whether the endpoint's handler gets `ctx.links`: on or in a dimension a link mount's `issuedBy` names its action for. */
const issuesLinks = (artifact: ContractArtifact, row: EndpointRow): boolean => {
	if (row.requirement?.kind !== 'action') return false
	const { action, access } = row.requirement
	return (access.form === 'on' || access.form === 'in')
		&& Object.values(artifact.mounts).some((mount) => mount.kind === 'link' && mount.dimension === access.dimension && mount.issuedBy === action)
}

/** Whether `shape` admits a principal id: a string, optional or nullable. */
const admitsString = (shape: SchemaShape | undefined): boolean =>
	shape?.type === 'string' || ((shape?.type === 'optional' || shape?.type === 'nullable') && admitsString(shape.inner))

/**
 * Whether a row of `table` lies directly in an object of `dimension`, the only rows the kit seeds there: a dimension
 * table whose container is `dimension`, or a child table of the table that owns it. A row further down needs a
 * container between, which the kit does not seed.
 */
const liesDirectlyIn = (policies: Policies, table: string, dimension: string): boolean => {
	const scope = policies[table]?.scope
	if (scope?.mode === 'dimension') return scope.container?.dimension === dimension
	const parent = scope?.mode === 'child' ? policies[scope.parent]?.scope : undefined
	return parent?.mode === 'dimension' && parent.dimension === dimension
}

/** The read action of the table that owns `dimension`, or `undefined` when no table owns it. */
const ownerRead = (policies: Policies, dimension: string): string | undefined =>
	tableActions(
		Object.values(policies).find((policy) => policy.scope.mode === 'dimension' && policy.scope.dimension === dimension)?.actions.read ?? null,
	)[0]

/**
 * What the `own` case's caller holds: the endpoint's action, plus what IAM requires of a link's issuer (the actions the
 * link grants) and of a member manager (an assigning role and the assigned role's actions).
 */
const ownGrants = (row: EndpointRow, artifact: ContractArtifact, action: string, dimension: string): string => {
	const issues = artifact.declared?.[row.id]?.issues
	const granted = Object.entries(artifact.mounts).flatMap(([name, mount]) =>
		mount.kind === 'link' && mount.dimension === dimension && mount.issuedBy === action && (issues === undefined || issues === name)
			? mount.grants
			: []
	)
	const held = [action, ...new Set(granted)].join(', ')
	return endpointMembers(artifact, row) === 'manage' ? `${held}, an assigning role and the assigned role's actions` : held
}

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
	if (access.form === 'creates') {
		return [
			testCase(
				`${row.id}: a caller with ${action} in one ${access.dimension} only creates none (403)`,
				`expect(await kit.scoped(${args})).toEqual({ status: 403 })`,
			),
			testCase(
				`${row.id}: a caller with ${action} held globally creates one`,
				`expect(await kit.global(${args})).toEqual({ answered: true })`,
			),
		]
	}
	if (access.form === 'app') {
		return [
			testCase(`${row.id}: a caller with ${action} in one scope only is 403`, `expect(await kit.scoped(${args})).toEqual({ status: 403 })`),
			testCase(`${row.id}: a caller with ${action} held globally reaches it`, `expect(await kit.global(${args})).toEqual({ answered: true })`),
		]
	}
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
					`${row.id}: a caller with only ${ownGrants(row, artifact, action, access.dimension)} reaches its own ${access.dimension}`,
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
 * An endpoint of several capabilities: one denied case per capability, each refused while every other one passes. An
 * object of another scope is 404 (`on`), a value of another scope 403 (`in`), and a caller without the action 403 (`over`).
 */
const capabilityCases = (row: EndpointRow, fixtures: EndpointFixtures): readonly Case[] => {
	if (row.requirement?.kind !== 'capabilities' || !row.callers.some((caller) => caller === 'human' || caller === 'machine')) return []
	const input = inputOf(row, fixtures)
	if (input === undefined) return []
	const seed = fixtures.seeds[row.id]
	return Object.entries(row.requirement.capabilities).map(([name, { action, access }]) => {
		const args = `${quote(row.id)}, ${quote(name)}, ${renderSample(input)}${seed === undefined ? '' : `, ${renderSample(seed)}`}`
		const call = `await kit.capability(${args})`
		if (access.form === 'over') {
			return testCase(`${row.id}: a caller without ${action} (capability ${name}) is 403`, `expect(${call}).toEqual({ status: 403 })`)
		}
		const status = access.form === 'on' ? 404 : 403
		return testCase(
			`${row.id}: the ${access.dimension} of another scope as capability ${name} is ${status}`,
			`expect(${call}).toEqual({ status: ${status} })`,
		)
	})
}

/**
 * A public procedure's case: anyone reaches it with no credential, or, behind a challenge, is refused without a solved
 * one. Its name carries the workload's actions, so a change of them makes the committed test stale.
 */
const publicCases = (row: EndpointRow, artifact: ContractArtifact, fixtures: EndpointFixtures): readonly Case[] => {
	// A `challenge` row is the framework's own issuer of a procedure's ALTCHA challenge: it runs no handler to test.
	if (row.kind !== 'public' || row.source.kind !== 'mount') return []
	const input = inputOf(row, fixtures)
	if (input === undefined) return []
	const call = `await kit.anyone(${quote(row.id)}, ${renderSample(input)})`
	const actions = artifact.declared?.[row.id]?.actions ?? []
	if (artifact.procedures?.[row.id]?.challenge != null) {
		return [testCase(`${row.id}: anyone without a solved challenge is 400`, `expect(${call}).toEqual({ answered: false, status: 400 })`)]
	}
	return [
		testCase(`${row.id}: anyone reaches it with no credential, running with ${actions.join(', ')}`, `expect(${call}).toEqual({ answered: true })`),
	]
}

/** The endpoint access test of the application, or `undefined` when no endpoint has an access form to test. */
const endpointTestBody = (
	artifact: ContractArtifact,
	policies: Policies,
	fixtures: EndpointFixtures,
	dialect: ApplicationDialect,
): { readonly body: string; readonly cases: readonly string[] } | undefined => {
	const cases = [...artifact.endpoints].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)).flatMap((
		row,
	) => [
		...endpointCases(row, artifact, policies, fixtures),
		...capabilityCases(row, fixtures),
		...publicCases(row, artifact, fixtures),
	])
	if (cases.length === 0) return undefined
	const database = testDatabaseLines(dialect, '../../db/migrations/')
	const body = [
		'// The endpoint access tests of this application, written by fabrika db test-scaffold from fabrika.contract.ts and',
		'// src/db/tables.ts. They run src/app.ts itself: callers of two scopes that share no value ask every endpoint with an',
		"// access form, and a caller with only the endpoint's action, plus what IAM requires of a member manager or a link's",
		'// issuer, asks for its own object. A handler bug that needs other data or another order is beyond them; the state a',
		'// precondition needs is a seed in endpoint-access.fixtures.ts.',
		'// Do not edit: @fabrika/check compares this file with what the scaffold writes; rerun it after a contract change.',
		'',
		"import { afterAll, describe, endpointAccessKit, expect, test } from '@fabrika/app/testing/isolation'",
		database.kit,
		"import app from '../app'",
		"import { tables } from '../db/tables'",
		'',
		"const label = 'endpoint-access.test.ts'",
		database.open,
		'',
		`if (${database.name} !== null) {`,
		`\tafterAll(() => ${database.name}.close())`,
		`\tconst kit = endpointAccessKit(app, tables, ${database.name})`,
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
 * Endpoint access tests exist only for an application on `@fabrika/db`, which has policies to seed rows from. They
 * open the test database of the application's dialect.
 */
export const generatedTests = async (
	policies: Policies,
	artifact: ContractArtifact | null,
	fixtures: EndpointFixtures = NO_FIXTURES,
	dialect: ApplicationDialect = 'postgres',
): Promise<ReadonlyMap<string, GeneratedTest>> => {
	const files = new Map<string, GeneratedTest>()
	// The kit's scoped sites are `over` the vocabulary's first dimension: without one, no scoped site exists.
	const scopedSites = artifact !== null && Object.keys(artifact.dimensions).length > 0
	for (const table of Object.keys(policies).sort()) {
		const test = policyTestBody(policies, table, scopedSites, dialect)
		if (test !== undefined) files.set(policyTestPath(table), await generated(test))
	}
	const endpoints = artifact === null || files.size === 0 ? undefined : endpointTestBody(artifact, policies, fixtures, dialect)
	if (endpoints !== undefined) files.set(ENDPOINT_ACCESS_TEST, await generated(endpoints))
	return files
}

export interface ScaffoldInputs {
	readonly policies: Policies
	readonly artifact: ContractArtifact | null
	readonly fixtures: EndpointFixtures
	readonly dialect: ApplicationDialect
}

/** What the scaffold reads from an application's files; throws `ContractSourceError` or `ContractError` as the reader does. */
export const scaffoldInputs = (files: ReadonlyMap<string, string>): ScaffoldInputs => {
	const tables = readTablesDefinition(files)
	const policies = tables === null ? {} : tablePolicies(tables)
	const fixtures = readEndpointFixtures(files)
	if (!fixtures.ok) throw new ContractSourceError(fixtures.findings)
	// Endpoint tests seed rows from the policies, so without src/db/tables.ts there is nothing to compile them against.
	const artifact = files.has(CONTRACT_FILE) && tables !== null ? readContractSource(files, tables) : null
	return { policies, artifact, fixtures: fixtures.fixtures, dialect: applicationDialect(files) }
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
			findings.push(
				at(`${id} is no endpoint with an on, in, over, app or creates access form, or several capabilities`, 'a fixture of a tested endpoint, or none'),
			)
		}
	}
	for (const [id, fields] of Object.entries(fixtures.members).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		const row = tested.find((candidate) => candidate.id === id && !isLinkProcedure(candidate))
		const directory = row === undefined ? null : endpointDirectory(artifact, row)
		if (row === undefined || directory === null) {
			findings.push(
				at(
					`${id} is no tested endpoint below a dimension with members, whose handler could look one up`,
					"export const members = { '<endpoint id>': ['<input field>'] }, for an endpoint on or in a dimension with members or below one",
				),
			)
			continue
		}
		const input = row.input
		for (const field of fields) {
			if (input?.type !== 'object' || !admitsString(input.fields[field])) {
				findings.push(at(`${id}: ${field} is no string field of its input, so it cannot name a member`, 'a top-level string field of the input'))
			}
		}
	}
	const sortedById = (fields: Readonly<Record<string, readonly string[]>>) =>
		Object.entries(fields).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	const holders = [
		{
			fields: fixtures.invitations,
			names: 'an invitation',
			admits: (row: EndpointRow) => endpointMembers(artifact, row) === 'manage',
			refusal: (id: string) => `${id} is no tested endpoint that manages a dimension's members, whose handler could cancel an invitation`,
			allowed: "export const invitations = { '<endpoint id>': ['<input field>'] }, for an endpoint with its dimension's members.manage",
		},
		{
			fields: fixtures.links,
			names: 'a share link',
			admits: (row: EndpointRow) => issuesLinks(artifact, row),
			refusal: (id: string) => `${id} is no tested endpoint that issues a share link, whose handler could revoke one`,
			allowed: "export const links = { '<endpoint id>': ['<input field>'] }, for an endpoint whose action a link mount's issuedBy names",
		},
	]
	for (const holder of holders) {
		for (const [id, fields] of sortedById(holder.fields)) {
			const row = tested.find((candidate) => candidate.id === id && !isLinkProcedure(candidate) && holder.admits(candidate))
			if (row === undefined) {
				findings.push(at(holder.refusal(id), holder.allowed))
				continue
			}
			for (const field of fields) {
				if (row.input?.type !== 'object' || !admitsString(row.input.fields[field])) {
					findings.push(at(`${id}: ${field} is no string field of its input, so it cannot name ${holder.names}`, 'a top-level string field of the input'))
				}
			}
		}
	}
	for (const [id, fields] of Object.entries(fixtures.rows).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
		const row = tested.find((candidate) => candidate.id === id)
		const access = row?.requirement?.kind === 'action' ? row.requirement.access : undefined
		const owned = access?.form === 'on' && ownerRead(policies, access.dimension) !== undefined
		if (row === undefined || access?.form !== 'on' || !owned) {
			findings.push(
				at(
					`${id} is no tested endpoint on an object a table owns, in which the kit could seed a row`,
					"export const rows = { '<endpoint id>': { <input field>: '<table>' } }, for an endpoint on a dimension a table owns",
				),
			)
			continue
		}
		for (const [field, table] of Object.entries(fields).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))) {
			if (row.input?.type !== 'object' || !admitsString(row.input.fields[field])) {
				findings.push(at(`${id}: ${field} is no string field of its input, so it cannot name a row`, 'a top-level string field of the input'))
			} else if (!liesDirectlyIn(policies, table, access.dimension)) {
				findings.push(
					at(
						`${id}: ${table} is no dimension or child table that lies directly in a ${access.dimension}, so the kit seeds none in the endpoint's object (it seeds no container between)`,
						`a child table of the table that owns ${access.dimension}, or a dimension table whose container is ${access.dimension}`,
					),
				)
			}
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
