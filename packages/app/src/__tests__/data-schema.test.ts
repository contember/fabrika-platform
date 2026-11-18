// A schema held as data builds the zod schema the same calls on zod build: the same shape, the same parse and the same
// issues, and the same inferred types. Its builds are cached up to a bound.

import type { SchemaShape } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { ContractError, Problems } from '../contract/problems'
import { describeSchema } from '../contract/schema-shape'
import { signedToken } from '../contract/token'
import { BUILT_SCHEMAS, DataSchema, z as d, zodOf, zodSchemaOf } from '../schema'

/** The schema's shape, or the problems that refuse it: a refusal is compared as a shape is. */
function shape(schema: z.core.$ZodType): SchemaShape | readonly string[] | null {
	const problems = new Problems()
	const described = describeSchema(schema, 'schema', problems)
	try {
		problems.throwIfAny()
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	return described
}

const Status = ['draft', 'sent', 'paid'] as const

/** Each pair: the schema as data, the same calls on zod, and values to parse with both. */
const PAIRS: readonly (readonly [string, DataSchema, z.ZodType, readonly unknown[]])[] = [
	['string bounds', d.string().min(1, 'required').max(5), z.string().min(1, 'required').max(5), ['', 'abc', 'abcdef', 3]],
	[
		'string checks',
		d.string().startsWith('a').endsWith('z').includes('m').regex(/^[a-z]+$/),
		z.string().startsWith('a').endsWith('z').includes('m').regex(/^[a-z]+$/),
		['amz', 'mz', 'aMz'],
	],
	['a refused option', d.string().includes('m', { position: 1 }), z.string().includes('m', { position: 1 }), ['amz', 'mz']],
	['string length', d.string().length(3).nonempty(), z.string().length(3).nonempty(), ['abc', 'ab']],
	['string formats', d.string().email({ message: 'an email' }), z.string().email({ message: 'an email' }), ['a@b.cz', 'nope']],
	['uuid', d.uuid({ version: 'v7' }), z.uuid({ version: 'v7' }), ['0190b0f4-7c2e-7a3b-9b1e-3c4d5e6f7a8b', '00000000-0000-4000-8000-000000000000']],
	['email and url', d.strictObject({ email: d.email(), url: d.url() }), z.strictObject({ email: z.email(), url: z.url() }), [{
		email: 'a@b.cz',
		url: 'https://x.cz',
	}, { email: 'x', url: 'y' }]],
	[
		'iso formats',
		d.strictObject({ date: d.iso.date(), at: d.iso.datetime({ offset: true, precision: 3 }), time: d.iso.time(), span: d.iso.duration() }),
		z.strictObject({ date: z.iso.date(), at: z.iso.datetime({ offset: true, precision: 3 }), time: z.iso.time(), span: z.iso.duration() }),
		[{ date: '2026-11-18', at: '2026-11-18T10:00:00.000+01:00', time: '10:00:00', span: 'P1D' }, {
			date: '18.11.2026',
			at: 'now',
			time: 'x',
			span: '1d',
		}],
	],
	['number checks', d.number().int().positive().lte(100).multipleOf(5), z.number().int().positive().lte(100).multipleOf(5), [5, 0, 101, 7, 2.5]],
	['number bounds', d.int().gt(0).lt(10).min(1).max(9), z.int().gt(0).lt(10).min(1).max(9), [1, 0, 10]],
	[
		'number signs',
		d.strictObject({ a: d.number().negative(), b: d.number().nonnegative(), c: d.number().nonpositive() }),
		z.strictObject({ a: z.number().negative(), b: z.number().nonnegative(), c: z.number().nonpositive() }),
		[{ a: -1, b: 0, c: 0 }, { a: 1, b: -1, c: 1 }],
	],
	[
		'literal and enum',
		d.strictObject({ kind: d.literal('a'), any: d.literal(['x', 1, true, null]), status: d.enum(Status), coded: d.enum({ One: 1, Two: 'two' }) }),
		z.strictObject({ kind: z.literal('a'), any: z.literal(['x', 1, true, null]), status: z.enum(Status), coded: z.enum({ One: 1, Two: 'two' }) }),
		[{ kind: 'a', any: 1, status: 'paid', coded: 'two' }, { kind: 'b', any: 2, status: 'void', coded: 3 }],
	],
	[
		'containers',
		d.strictObject({
			tags: d.array(d.string()).min(1),
			pair: d.tuple([d.string(), d.number()]),
			rest: d.tuple([d.string()], d.boolean()),
			map: d.record(d.string(), d.number()),
			keyed: d.record(d.enum(Status), d.boolean()),
		}),
		z.strictObject({
			tags: z.array(z.string()).min(1),
			pair: z.tuple([z.string(), z.number()]),
			rest: z.tuple([z.string()], z.boolean()),
			map: z.record(z.string(), z.number()),
			keyed: z.record(z.enum(Status), z.boolean()),
		}),
		[{ tags: ['a'], pair: ['a', 1], rest: ['a', true, false], map: { a: 1 }, keyed: { draft: true, sent: false, paid: true } }, {
			tags: [],
			pair: [1, 'a'],
			rest: [],
			map: { a: 'x' },
			keyed: {},
		}],
	],
	[
		'wrappers',
		d.strictObject({
			a: d.string().optional(),
			b: d.string().nullable(),
			c: d.string().nullish(),
			d: d.optional(d.number()),
			e: d.nullable(d.number()),
			f: d.string().array(),
			g: d.number().default(3),
		}),
		z.strictObject({
			a: z.string().optional(),
			b: z.string().nullable(),
			c: z.string().nullish(),
			d: z.optional(z.number()),
			e: z.nullable(z.number()),
			f: z.string().array(),
			g: z.number().default(3),
		}),
		[{ b: null, f: [] }, { a: 1, b: undefined, f: 'x' }, { b: 'x', f: ['a'], g: 'x' }],
	],
	[
		'unions',
		d.strictObject({
			either: d.union([d.string(), d.number()]),
			or: d.string().or(d.boolean()),
			tagged: d.discriminatedUnion('type', [
				d.strictObject({ type: d.literal('a'), a: d.string() }),
				d.strictObject({ type: d.literal('b'), b: d.number() }),
			]),
		}),
		z.strictObject({
			either: z.union([z.string(), z.number()]),
			or: z.string().or(z.boolean()),
			tagged: z.discriminatedUnion('type', [
				z.strictObject({ type: z.literal('a'), a: z.string() }),
				z.strictObject({ type: z.literal('b'), b: z.number() }),
			]),
		}),
		[{ either: 1, or: true, tagged: { type: 'b', b: 1 } }, { either: null, or: 1, tagged: { type: 'c' } }],
	],
	[
		'object methods',
		d.strictObject({ id: d.uuid(), name: d.string(), note: d.string() }).extend({ age: d.int() }).omit({ note: true }).partial({ name: true }).describe(
			'a person',
		),
		z.strictObject({ id: z.uuid(), name: z.string(), note: z.string() }).extend({ age: z.int() }).omit({ note: true }).partial({ name: true }).describe(
			'a person',
		),
		[{ id: '0190b0f4-7c2e-7a3b-9b1e-3c4d5e6f7a8b', age: 3 }, { id: 'x', name: 1, note: 'n' }],
	],
	[
		'pick and partial',
		d.strictObject({ a: d.string(), b: d.number() }).pick({ a: true }).partial(),
		z.strictObject({ a: z.string(), b: z.number() }).pick({ a: true }).partial(),
		[{}, { a: 'x' }, { b: 1 }],
	],
	[
		'a zod schema inside',
		d.strictObject({ token: signedToken('invite'), plain: z.string().min(2) }),
		z.strictObject({ token: signedToken('invite'), plain: z.string().min(2) }),
		[{ token: 'abc', plain: 'xy' }, { token: '', plain: 'x' }],
	],
]

describe('a schema held as data', () => {
	test('builds the schema the same calls on zod build: its shape, its parse and its issues', () => {
		for (const [name, data, zod, values] of PAIRS) {
			const built = zodSchemaOf(data)
			expect(shape(built), name).toEqual(shape(zod))
			for (const value of values) {
				const ours = z.safeParse(built, value)
				const theirs = z.safeParse(zod, value)
				expect(ours.success, `${name} ${JSON.stringify(value)}`).toBe(theirs.success)
				expect(ours.data, name).toEqual(theirs.data)
				expect(ours.error?.issues, name).toEqual(theirs.error?.issues)
			}
		}
	})

	test('parses as zod parses, and reads as zod reads', () => {
		const Person = d.strictObject({ name: d.string().min(1), status: d.enum(Status) })
		expect(Person.parse({ name: 'Ada', status: 'paid' })).toEqual({ name: 'Ada', status: 'paid' })
		expect(() => Person.parse({ name: '', status: 'paid' })).toThrow()
		expect(Person.safeParse({ name: 'Ada', status: 'void' }).success).toBe(false)
		expect(Person['~standard'].vendor).toBe('zod')
		expect(Object.keys(Person.shape)).toEqual(['name', 'status'])
		expect(Person.shape.name.safeParse('').success).toBe(false)
		const status = d.enum(Status)
		expect(status.options).toEqual(['draft', 'sent', 'paid'])
		expect(status.enum).toEqual({ draft: 'draft', sent: 'sent', paid: 'paid' })
		expect(status.exclude(['draft']).options).toEqual(['sent', 'paid'])
		expect(status.extract(['paid']).options).toEqual(['paid'])
	})

	test('infers the types zod infers', () => {
		const Person = d.strictObject({ name: d.string(), age: d.int().optional(), tags: d.array(d.enum(Status)), token: signedToken('invite') })
		const Zod = z.strictObject({ name: z.string(), age: z.int().optional(), tags: z.array(z.enum(Status)), token: signedToken('invite') })
		const same: Same<d.infer<typeof Person>, z.infer<typeof Zod>> = true
		const input: Same<d.input<typeof Person>, z.input<typeof Zod>> = true
		const parsed: Same<ReturnType<typeof Person.parse>, z.output<typeof Zod>> = true
		expect([same, input, parsed]).toEqual([true, true, true])
	})

	test('records its calls and builds no zod until something uses it', () => {
		const schema = d.string().min(1)
		expect(schema.name).toBe('min')
		expect(schema.receiver?.name).toBe('string')
		expect(schema.args).toEqual([1])
		expect(Object.isFrozen(schema)).toBe(true)
	})

	test('keeps its arguments as they were at the call, so a rebuild after eviction builds the same schema', () => {
		const shape: Record<string, ReturnType<typeof d.string>> = { a: d.string() }
		const schema = d.strictObject(shape)
		shape['b'] = d.string()
		for (let index = 0; index < BUILT_SCHEMAS; index++) {
			zodOf(d.number().min(index))
		}
		expect(zodOf(schema).safeParse({ a: 'x' }).success).toBe(true)
		expect(Object.keys(zodOf(schema).shape)).toEqual(['a'])
	})

	test('keeps the most recently used builds, up to its bound', () => {
		const first = d.string()
		const kept = zodOf(first)
		expect(zodOf(first)).toBe(kept)
		for (let index = 0; index < BUILT_SCHEMAS; index++) {
			zodOf(d.number().min(index))
		}
		expect(zodOf(first)).not.toBe(kept)
	})

	test('refuses a step outside the subset when it builds', () => {
		const loose = new DataSchema('object', false, null, [{}])
		expect(() => zodSchemaOf(loose)).toThrow("'object' is not in the supported schema subset")
		const picked = new DataSchema('pick', false, d.strictObject({ a: d.string() }), [{ b: true }])
		expect(() => zodSchemaOf(picked)).toThrow('zod refuses this schema')
	})
})

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
