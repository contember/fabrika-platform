// The leak sweep: one call in an application's suite asks every endpoint that answers rows of a scope from two scopes
// that share no value, cases planned in memory from the contract. It fails only on a leak; whatever it cannot set up
// (an input, a row the seeder cannot write, a refused answer) is a hint it prints, never a failure.

import type { EndpointRow, TablePolicyArtifact } from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import type { TestDatabase } from '@fabrika/db/testing'
import { compileContract } from '../contract/compile'
import type { AnyContract } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import { type EndpointAccessKit, endpointAccessKit, type EndpointAccessOptions, type Seed } from './endpoint-access'
import { afterAll, describe, expect, test } from './runner'
import { sampleOf } from './sample-input'

export interface LeakSweepOptions extends EndpointAccessOptions {
	/**
	 * Input fields by endpoint id, laid over the sample of its schema (the whole input where no sample exists).
	 * `GENERATED_MEMBER` is a member of the target's scope, `${GENERATED_ROW_PREFIX}<table>` a row seeded in the target.
	 */
	readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	/** Column → value of the row an `on` or `in` endpoint addresses, by endpoint id: the state its precondition needs. */
	readonly seeds?: Readonly<Record<string, Seed>>
}

export interface SweepCase {
	readonly endpoint: string
	readonly input: Readonly<Record<string, unknown>>
	readonly seed: Seed
}

/** A plain object, the only input an RPC procedure takes. */
function isInputObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the sweep asks `row`: a query or a mutation a person or a script calls with one action on, in or over a
 * dimension. `app` and `creates` need a global grant, a link procedure reaches its link's object only.
 */
function isSwept(row: EndpointRow): boolean {
	if (row.kind !== 'query' && row.kind !== 'mutation') return false
	if (!row.callers.some((caller) => caller === 'human' || caller === 'machine')) return false
	const requirement = row.requirement
	return requirement?.kind === 'action' && (requirement.access.form === 'on' || requirement.access.form === 'in' || requirement.access.form === 'over')
}

/** The cases of the sweep, in endpoint order, and the hints of what it does not ask. */
export function planSweep<DB, P>(
	app: ContractImplementation<AnyContract>,
	tables: Tables<DB, P> | Readonly<Record<string, TablePolicyArtifact>>,
	options: LeakSweepOptions = {},
): { readonly cases: readonly SweepCase[]; readonly hints: readonly string[] } {
	const artifact = compileContract(app.contract, tables)
	const cases: SweepCase[] = []
	const hints: string[] = []
	const rows = [...artifact.endpoints].filter(isSwept).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
	for (const row of rows) {
		const declared = artifact.declared?.[row.id]
		if (declared !== undefined && Object.keys(declared.unscoped).length > 0) {
			hints.push(`${row.id}: declares unscoped, so it reaches across scopes by design; the sweep does not ask it`)
			continue
		}
		const sample = row.input === null ? {} : sampleOf(row.input)
		const given = options.inputs?.[row.id]
		const input = isInputObject(sample) ? { ...sample, ...given } : given
		if (!isInputObject(input)) {
			hints.push(`${row.id}: the sweep cannot sample its input schema (a pattern, or bounds it cannot meet); give the input in inputs`)
			continue
		}
		const seed = options.seeds?.[row.id]
		if (seed !== undefined && row.requirement?.kind === 'action' && row.requirement.access.form === 'over') {
			hints.push(`${row.id}: lists over a dimension and addresses no row, so its seed in seeds is not used`)
		}
		cases.push({ endpoint: row.id, input, seed: seed ?? {} })
	}
	const named = new Set(rows.map((row) => row.id))
	const unknown = (option: string, keys: readonly string[]) =>
		keys.filter((id) => !named.has(id)).map((id) => `${id}: ${option} names it, but the sweep asks no such endpoint`)
	hints.push(...unknown('inputs', Object.keys(options.inputs ?? {})), ...unknown('seeds', Object.keys(options.seeds ?? {})))
	if (rows.length === 0) {
		hints.push('no endpoint is on, in or over a dimension, so no answer can hold rows of another scope; the sweep asks nothing')
	}
	return { cases, hints }
}

/** One case through `kit`: what it found (a leak each), and its hints, each naming the endpoint. */
export async function sweepCase(
	kit: EndpointAccessKit,
	{ endpoint, input, seed }: SweepCase,
): Promise<{ readonly found: readonly string[]; readonly hints: readonly string[] }> {
	const outcome = await kit.swept(endpoint, input, seed)
	const found = outcome.leaked.map((value) => `the answer to one scope holds ${value}, a value of another scope`)
	if (outcome.differential === 'changed') found.push('the answer to one scope changed when only rows of scopes it does not hold were added')
	return { found, hints: outcome.hints.map((hint) => (hint.startsWith(`${endpoint}:`) ? hint : `${endpoint}: ${hint}`)) }
}

/**
 * Registers the leak sweep of `app`, whose data layer is `scoped(tables)`, over `database`: one case per planned
 * endpoint, failing only on a leak, with every hint printed after the run. A `null` database registers nothing.
 */
export function leakSweep<DB, P>(
	app: ContractImplementation<AnyContract>,
	tables: Tables<DB, P>,
	database: TestDatabase | null,
	options: LeakSweepOptions = {},
): void {
	if (database === null) return
	afterAll(() => database.close())
	const { cases, hints: planned } = planSweep(app, tables, options)
	const hints = [...planned]
	afterAll(() => {
		if (hints.length > 0) {
			console.info(`leak sweep: ${hints.length} hint(s), what it could not check:\n${hints.map((hint) => `  - ${hint}`).join('\n')}`)
		}
		return Promise.resolve()
	})
	const kit = endpointAccessKit(app, tables, database, options)
	describe('leak sweep: an answer to one scope holds nothing of another', () => {
		for (const item of cases) {
			test(item.endpoint, async () => {
				const { found, hints: own } = await sweepCase(kit, item)
				hints.push(...own)
				expect(found).toEqual([])
			})
		}
	})
}
