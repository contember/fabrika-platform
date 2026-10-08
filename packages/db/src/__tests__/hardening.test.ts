// The two attacks that succeeded against the spike both patched globals in the same process: the Kysely compiler
// after the guard ran, and the built-ins the allowlists use. Loading the layer freezes the compiler, and the guard
// and every policy and allowlist check keep their own references to the built-ins, so both now fail.

import { describe, expect, test } from 'bun:test'
import { DefaultQueryCompiler, PostgresQueryCompiler } from 'kysely'
import { CapabilityError, QueryRefusedError } from '../errors'
import { call, type Outcome, recordingLayer } from './fixtures/harness'
import { patchedChecks } from './fixtures/patch'

describe('the compiler cannot be patched after the guard ran', () => {
	test('its prototypes are frozen once the layer is loaded', () => {
		recordingLayer()
		expect(Object.isFrozen(PostgresQueryCompiler.prototype)).toBe(true)
		expect(Object.isFrozen(DefaultQueryCompiler.prototype)).toBe(true)
	})

	test('replacing compileQuery (to drop the WHERE) throws', () => {
		const original = PostgresQueryCompiler.prototype.compileQuery
		expect(() => {
			PostgresQueryCompiler.prototype.compileQuery = function(node, queryId) {
				return original.call(this, { ...node, where: undefined }, queryId)
			}
		}).toThrow(TypeError)
		expect(Reflect.set(DefaultQueryCompiler.prototype, 'visitWhere', () => {})).toBe(false)
	})
})

describe('patched built-ins do not disable the guard', () => {
	test('with Set.has, Array.find, Object.hasOwn, Object.keys and Object.getOwnPropertyDescriptor patched, an injected operator is still refused', async () => {
		const layer = recordingLayer()
		const injected = '= $1) or true or ("notes"."title" ='
		const outcome = await patchedChecks(
			{
				setHas: true,
				find: injected,
				hasOwn: true,
				keys: [],
				getOwnPropertyDescriptor: undefined,
				isArray: false,
			},
			() => layer.attempt(() => call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => call(q, 'where', 'title', injected, 'x'))),
		)
		expect(outcome.error).toBeInstanceOf(QueryRefusedError)
		expect(outcome.error?.message).toContain('not allowed')
		expect(outcome.statements).toEqual([])
	})
})

describe('patched built-ins do not disable the policy and allowlist checks', () => {
	const allowAll = { setHas: true, includes: true, some: true, hasOwnProperty: true, hasOwn: true } as const

	function refused(outcome: Outcome, kind: typeof CapabilityError | typeof QueryRefusedError, message: string): void {
		expect(outcome.error).toBeInstanceOf(kind)
		expect(outcome.error?.message).toContain(message)
		expect(outcome.statements).toEqual([])
	}

	test('the patches are in effect while the store runs', async () => {
		const seen = await patchedChecks(allowAll, async () => {
			const hasOwnProperty: unknown = Reflect.get(Object.prototype, 'hasOwnProperty')
			return [new Set().has('x'), ['a'].includes('b'), typeof hasOwnProperty === 'function' && Reflect.apply(hasOwnProperty, {}, ['x'])]
		})
		expect(seen).toEqual([true, true, true])
	})

	test('a scope column in update data is still refused', async () => {
		const layer = recordingLayer()
		const outcome = await patchedChecks(
			allowAll,
			() =>
				layer.attempt(() =>
					call(layer.raw.notes, 'update', layer.noteRef('notes.write'), { workspace_id: 'w2', organization_id: 'o2' }, { expectVersion: 1 })
				),
		)
		refused(outcome, QueryRefusedError, 'workspace_id is not an update column of notes')
	})

	test('a restricted column is still never selected, filtered or aggregated', async () => {
		const layer = recordingLayer()
		const within = layer.within('notes.read')
		const attempts = [
			() => call(layer.raw.notes, 'select', within, (q: unknown) => call(q, 'columns', ['internal'])),
			() => call(layer.raw.notes, 'select', within, (q: unknown) => call(q, 'where', 'internal', '=', 'x')),
			() => call(layer.raw.notes, 'aggregate', within, { min: ['internal'] }),
		]
		for (const attempt of attempts) {
			refused(await patchedChecks(allowAll, () => layer.attempt(attempt)), QueryRefusedError, 'internal is not a column of notes')
		}
	})

	test('a chain entry the table carries no column for is still refused', async () => {
		const layer = recordingLayer()
		const deeper = layer.capabilities.ref('note', 'notes.read', 'n1', { workspace: 'w1', organization: 'o1', region: 'eu' })
		const outcome = await patchedChecks(allowAll, () => layer.attempt(() => layer.stores.notes.get(deeper)))
		refused(outcome, CapabilityError, 'lies in region')
	})

	test('a table that is not a store table is still refused', async () => {
		const layer = recordingLayer()
		const outcome = await patchedChecks(allowAll, () => layer.attempt(() => call(layer.stores, 'defineStore', 'hasOwnProperty', (t: unknown) => t)))
		refused(outcome, QueryRefusedError, 'hasOwnProperty is not a dimension table')
	})
})
