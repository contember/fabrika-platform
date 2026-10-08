// The two attacks that succeeded against the spike both patched globals in the same process: the Kysely compiler
// after the guard ran, and the built-ins the allowlists use. Loading the layer freezes the compiler and the guard
// keeps its own references to the built-ins, so both now fail.

import { describe, expect, test } from 'bun:test'
import { DefaultQueryCompiler, PostgresQueryCompiler } from 'kysely'
import { QueryRefusedError } from '../errors'
import { call, recordingLayer } from './fixtures/harness'

function patch(target: object, key: PropertyKey, replacement: unknown): () => void {
	const original: unknown = Reflect.get(target, key)
	Reflect.set(target, key, replacement)
	return () => {
		Reflect.set(target, key, original)
	}
}

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
		const restore = [
			patch(Set.prototype, 'has', () => true),
			patch(Array.prototype, 'find', () => injected),
			patch(Object, 'hasOwn', () => true),
			patch(Object, 'keys', () => []),
			patch(Object, 'getOwnPropertyDescriptor', () => undefined),
			patch(Array, 'isArray', () => false),
		]
		let outcome: Awaited<ReturnType<typeof layer.attempt>>
		try {
			outcome = await layer.attempt(() =>
				call(layer.raw.notes, 'select', layer.within('notes.read'), (q: unknown) => call(q, 'where', 'title', injected, 'x'))
			)
		} finally {
			for (const undo of restore) {
				undo()
			}
		}
		expect(outcome.error).toBeInstanceOf(QueryRefusedError)
		expect(outcome.error?.message).toBe('operator not allowed')
		expect(outcome.statements).toEqual([])
	})
})
