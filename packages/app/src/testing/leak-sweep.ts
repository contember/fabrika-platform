// The leak sweep: one call in an application's suite asks every endpoint that answers rows of a scope from two scopes
// that share no value, cases planned in memory from the contract. It fails only on a leak; whatever it cannot set up
// (an input, a row the seeder cannot write, a refused answer) is a hint it prints, never a failure.

import type { EndpointRow } from '@fabrika/auth-core'
import type { Tables } from '@fabrika/db'
import type { TestDatabase } from '@fabrika/db/testing'
import { compileContract } from '../contract/compile'
import type { AnyContract } from '../contract/define'
import type { ContractImplementation } from '../implement/implement'
import { endpointAccessKit, type EndpointAccessOptions, type Seed } from './endpoint-access'
import { afterAll, describe, expect, test } from './runner'
import { sampleOf } from './sample-input'

export interface LeakSweepOptions extends EndpointAccessOptions {
	/**
	 * Input fields by endpoint id, laid over the sample of its schema (the whole input where no sample exists): where the
	 * sample reaches no answer. `GENERATED_MEMBER` in a field becomes a member of the target's scope, and
	 * `${GENERATED_ROW_PREFIX}<table>` the key of a row of that table seeded in the target.
	 */
	readonly inputs?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
	/** Column → value of the row the endpoint addresses, in both scopes, by endpoint id: the state its precondition needs. */
	readonly seeds?: Readonly<Record<string, Seed>>
}

interface SweepCase {
	readonly endpoint: string
	readonly input: Readonly<Record<string, unknown>>
	readonly seed: Seed
}

/** A plain object, the only input an RPC procedure takes. */
function isInputObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether the sweep asks `row`: a query or a mutation that a person or a script calls with one action on, in or over
 * a dimension. The other forms answer no rows of a scope: `app` and `creates` need a global grant, a link procedure
 * reaches only its link's object, and several capabilities are refused before the handler runs.
 */
function swept(row: EndpointRow): boolean {
	if (row.kind !== 'query' && row.kind !== 'mutation') return false
	if (!row.callers.some((caller) => caller === 'human' || caller === 'machine')) return false
	const requirement = row.requirement
	return requirement?.kind === 'action' && (requirement.access.form === 'on' || requirement.access.form === 'in' || requirement.access.form === 'over')
}

/** The cases of the sweep and the hints of what it does not ask, in endpoint order. */
function planSweep<DB, P>(
	app: ContractImplementation<AnyContract>,
	tables: Tables<DB, P>,
	options: LeakSweepOptions,
): { readonly cases: readonly SweepCase[]; readonly hints: readonly string[] } {
	const artifact = compileContract(app.contract, tables)
	const cases: SweepCase[] = []
	const hints: string[] = []
	const rows = [...artifact.endpoints].filter(swept).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
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
			hints.push(`${row.id}: no sample of its input schema exists (a pattern or contradictory bounds); give one in the sweep's inputs`)
			continue
		}
		cases.push({ endpoint: row.id, input, seed: options.seeds?.[row.id] ?? {} })
	}
	if (rows.length === 0) {
		hints.push('no endpoint is on, in or over a dimension, so no answer can hold rows of another scope; the sweep asks nothing')
	}
	return { cases, hints }
}

/**
 * Registers the leak sweep of `app`, whose data layer is `scoped(tables)`, over `database`: one case per endpoint that
 * answers rows of a scope. A caller of one scope asks after a caller of another; the answer must hold no value of the
 * other scope's rows, and a query's answer must not change when rows are added in scopes the caller does not hold. A
 * `null` database (`testDatabase` without its backend, which says what to set) registers nothing. Only an application
 * that calls it is swept; nothing requires the call.
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
		for (const { endpoint, input, seed } of cases) {
			test(endpoint, async () => {
				const found: string[] = []
				try {
					const outcome = await kit.swept(endpoint, input, seed)
					found.push(...outcome.leaked.map((value) => `the answer to one scope holds ${value}, a value of another scope`))
					if (outcome.changed === true) found.push('the answer to one scope changed when only rows of scopes it does not hold were added')
					if (!outcome.answered) {
						hints.push(`${endpoint}: its own scope was answered ${outcome.status}, so no answer was checked (inputs or seeds may reach it)`)
					}
					if (outcome.unvaried.length > 0) {
						hints.push(`${endpoint}: the seeder could not add a row to ${outcome.unvaried.join(', ')}, so the sweep did not vary them`)
					}
				} catch (error) {
					const message = error instanceof Error ? error.message : 'the case could not be set up'
					hints.push(message.startsWith(`${endpoint}:`) ? message : `${endpoint}: ${message}`)
				}
				expect(found).toEqual([])
			})
		}
	})
}
