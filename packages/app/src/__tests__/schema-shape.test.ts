// Every factory and method of the schema subset `@fabrika/check` accepts (packages/check/CLAUDE.md) has a shape, so
// a contract the checker passes also compiles.

import type { NumberShape, SchemaShape, StringShape } from '@fabrika/auth-core'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { ContractError, Problems } from '../contract/problems'
import { describeSchema } from '../contract/schema-shape'

function shape(schema: z.core.$ZodType): SchemaShape | null {
	const problems = new Problems()
	const described = describeSchema(schema, 'schema', problems)
	problems.throwIfAny()
	return described
}

function refusal(schema: z.core.$ZodType): readonly string[] {
	try {
		shape(schema)
	} catch (error) {
		if (error instanceof ContractError) {
			return error.problems
		}
		throw error
	}
	throw new Error('the schema was accepted')
}

const string = (constraints: Partial<Omit<StringShape, 'type'>> = {}): StringShape => ({
	type: 'string',
	format: null,
	minLength: null,
	maxLength: null,
	pattern: null,
	startsWith: null,
	endsWith: null,
	includes: null,
	...constraints,
})

const number = (constraints: Partial<Omit<NumberShape, 'type'>> = {}): NumberShape => ({
	type: 'number',
	int: false,
	min: null,
	exclusiveMin: false,
	max: null,
	exclusiveMax: false,
	multipleOf: null,
	...constraints,
})

describe('the factories of the subset', () => {
	test.each<[string, z.core.$ZodType, SchemaShape]>([
		['strictObject', z.strictObject({ a: z.string() }), { type: 'object', fields: { a: string() } }],
		['string', z.string(), string()],
		['number', z.number(), number()],
		['int', z.int(), number({ int: true })],
		['boolean', z.boolean(), { type: 'boolean' }],
		['null', z.null(), { type: 'null' }],
		['literal', z.literal('a'), { type: 'literal', value: 'a' }],
		['literal of several values', z.literal(['a', 1]), { type: 'union', options: [{ type: 'literal', value: 'a' }, { type: 'literal', value: 1 }] }],
		['enum', z.enum(['a', 'b']), { type: 'enum', values: ['a', 'b'] }],
		['array', z.array(z.boolean()), { type: 'array', items: { type: 'boolean' }, minItems: null, maxItems: null }],
		['tuple', z.tuple([z.string()], z.null()), { type: 'tuple', items: [string()], rest: { type: 'null' } }],
		['union', z.union([z.string(), z.null()]), { type: 'union', options: [string(), { type: 'null' }] }],
		[
			'discriminatedUnion',
			z.discriminatedUnion('k', [z.strictObject({ k: z.literal('a') }), z.strictObject({ k: z.literal('b') })]),
			{
				type: 'union',
				options: [
					{ type: 'object', fields: { k: { type: 'literal', value: 'a' } } },
					{ type: 'object', fields: { k: { type: 'literal', value: 'b' } } },
				],
			},
		],
		['record', z.record(z.string(), z.number()), { type: 'record', key: string(), value: number() }],
		['optional', z.optional(z.string()), { type: 'optional', inner: string() }],
		['nullable', z.nullable(z.string()), { type: 'nullable', inner: string() }],
		['uuid', z.uuid(), string({ format: 'uuid' })],
		['email', z.email(), string({ format: 'email' })],
		['url', z.url(), string({ format: 'url' })],
		['iso.date', z.iso.date(), string({ format: 'date' })],
		['iso.datetime', z.iso.datetime(), string({ format: 'datetime' })],
		['iso.time', z.iso.time(), string({ format: 'time' })],
		['iso.duration', z.iso.duration(), string({ format: 'duration' })],
	])('%s', (_name, schema, expected) => {
		expect(shape(schema)).toEqual(expected)
	})
})

describe('the methods of the subset', () => {
	const Base = z.strictObject({ a: z.string(), b: z.number() })

	test.each<[string, z.core.$ZodType, SchemaShape]>([
		['min, max on a string', z.string().min(2).max(9), string({ minLength: 2, maxLength: 9 })],
		['length, nonempty', z.string().nonempty().length(4), string({ minLength: 4, maxLength: 4 })],
		['email, uuid, url as methods', z.strictObject({ e: z.string().email(), u: z.string().uuid(), l: z.string().url() }), {
			type: 'object',
			fields: { e: string({ format: 'email' }), u: string({ format: 'uuid' }), l: string({ format: 'url' }) },
		}],
		[
			'startsWith, endsWith, includes, regex',
			z.string().startsWith('a').endsWith('z').includes('m').regex(/^a.*z$/),
			string({
				startsWith: 'a',
				endsWith: 'z',
				includes: 'm',
				pattern: '^a.*z$',
			}),
		],
		['int, positive', z.number().int().positive(), number({ int: true, min: 0, exclusiveMin: true })],
		['negative', z.number().negative(), number({ max: 0, exclusiveMax: true })],
		['nonnegative, nonpositive', z.number().nonnegative().nonpositive(), number({ min: 0, max: 0 })],
		['gt, lte keep the tighter bound', z.number().gt(1).gte(1).lte(9).lt(9), number({ min: 1, exclusiveMin: true, max: 9, exclusiveMax: true })],
		['min, max on a number', z.number().min(1).max(3), number({ min: 1, max: 3 })],
		['multipleOf', z.number().multipleOf(5), number({ multipleOf: 5 })],
		['min, max on an array', z.array(z.null()).min(1).max(3), { type: 'array', items: { type: 'null' }, minItems: 1, maxItems: 3 }],
		['optional, nullable, nullish', z.strictObject({ o: z.string().optional(), n: z.string().nullable(), x: z.string().nullish() }), {
			type: 'object',
			fields: {
				o: { type: 'optional', inner: string() },
				n: { type: 'nullable', inner: string() },
				x: { type: 'optional', inner: { type: 'nullable', inner: string() } },
			},
		}],
		['default makes the value optional', z.string().default('x'), { type: 'optional', inner: string() }],
		['describe adds nothing', z.string().describe('a note'), string()],
		['array, or', z.string().array().or(z.null()), {
			type: 'union',
			options: [{ type: 'array', items: string(), minItems: null, maxItems: null }, { type: 'null' }],
		}],
		['extend, pick, omit, partial keep the object strict', Base.extend({ c: z.boolean() }).omit({ b: true }).pick({ a: true, c: true }).partial(), {
			type: 'object',
			fields: { a: { type: 'optional', inner: string() }, c: { type: 'optional', inner: { type: 'boolean' } } },
		}],
	])('%s', (_name, schema, expected) => {
		expect(shape(schema)).toEqual(expected)
	})
})

describe('forms outside the subset', () => {
	test.each<[string, z.core.$ZodType, string]>([
		['z.object', z.object({ a: z.string() }), 'schema: the object admits undeclared keys (allowed: z.strictObject({ … }))'],
		['a loose object', z.looseObject({ a: z.string() }), 'schema: the object admits undeclared keys (allowed: z.strictObject({ … }))'],
		['refine', z.number().refine((value) => value > 1), "schema: a 'custom' check is outside the contract subset"],
		['transform', z.string().transform((value) => value.length), "schema: a 'pipe' schema is outside the contract subset"],
		['catch', z.string().catch('x'), "schema: a 'catch' schema is outside the contract subset"],
		['lowercase', z.string().lowercase(), "schema: the string format 'lowercase' with these options is outside the contract subset"],
		['uuidv4', z.uuidv4(), "schema: the string format 'uuid' with these options is outside the contract subset"],
		['coerce', z.coerce.number(), 'schema: a coercing schema is outside the contract subset'],
		['two patterns', z.string().regex(/a/).regex(/b/), 'schema: the string calls .regex() twice (allowed: one .regex() per string)'],
		['a bigint literal', z.literal(1n), 'schema: the literal 1 is not JSON'],
		['a numeric enum', z.enum({ a: 1 }), 'schema: the enum value 1 is not a string'],
		['a date', z.date(), "schema: a 'date' schema is outside the contract subset"],
		['a coercing boolean', z.coerce.boolean(), 'schema: a coercing schema is outside the contract subset'],
		['two formats', z.string().email().uuid(), 'schema: the string has two formats, email and uuid (allowed: one format per string)'],
		['a negative length', z.string().max(-1), 'schema: the length -1 is not a whole number of at least 0'],
		['a fractional length', z.array(z.null()).min(1.5), 'schema: the length 1.5 is not a whole number of at least 0'],
		['a minimum above the maximum', z.array(z.null()).min(5).max(2), 'schema: the minimum 5 is above the maximum 2, so nothing is admitted'],
		['a zero step', z.number().multipleOf(0), 'schema: .multipleOf(0) is not a positive step'],
		['an infinite bound', z.number().max(Number.POSITIVE_INFINITY), 'schema: the bound Infinity is not a finite number'],
		['bounds that exclude everything', z.number().gt(1).lt(1), 'schema: the bounds 1 and 1 admit no number'],
		['an affix with a format', z.uuid().startsWith('0'), ".startsWith(), .endsWith() and .includes() do not combine with the format 'uuid'"],
	])('%s', (_name, schema, expected) => {
		expect(refusal(schema).join('\n')).toContain(expected)
	})
})

describe('forms whose meaning the artifact cannot keep', () => {
	test('z.url() with another string check depends on their order, so either order is refused', () => {
		const urlFirst = z.string().url().startsWith('https://example.com')
		const urlLast = z.string().startsWith('https://example.com').url()
		expect(urlFirst.safeParse('HTTPS://EXAMPLE.COM').success).toBe(true)
		expect(urlLast.safeParse('HTTPS://EXAMPLE.COM').success).toBe(false)
		const refused = 'schema: z.url() rewrites the value, so another string check depends on its order (allowed: z.url() with no other check)'
		expect(refusal(urlFirst)).toEqual([refused])
		expect(refusal(urlLast)).toEqual([refused])
		expect(refusal(z.url().max(50))).toEqual([refused])
	})

	test('a format with a length is order-free and kept', () => {
		expect(shape(z.email().max(254))).toEqual(string({ format: 'email', maxLength: 254 }))
	})

	test('a discriminator with a default admits a value the plain union would describe differently, so it is refused', () => {
		const options = [z.strictObject({ kind: z.literal('a').default('a') }), z.strictObject({ kind: z.literal('b') })] as const
		expect(z.discriminatedUnion('kind', [...options]).safeParse({}).success).toBe(false)
		expect(z.union([...options]).safeParse({}).success).toBe(true)
		expect(refusal(z.discriminatedUnion('kind', [...options]))).toEqual([
			"schema: the discriminator 'kind' has a default (allowed: a required literal in every option)",
		])
	})
})
