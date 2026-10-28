// @fabrika/db/hyperdrive — the data layer over postgres.js, as a Cloudflare Worker reaches Postgres through Hyperdrive
// (ADR-0065). It imports neither `bun` nor `postgres`, so it loads in workerd: the runtime hands it the client of the
// event that runs. Hyperdrive pools connections per transaction and documents no startup parameters, so the schema is the
// runtime role's own default `search_path` (`provisionPostgresRoles` sets it), never a session setting.

import type { PostgresJSReservedSql, PostgresJSSql } from 'kysely-postgres-js'
import { PostgresJSDialect } from 'kysely-postgres-js'
import { Buffer } from 'node:buffer'
import { Database } from './database'
import { DatabaseError, QueryRefusedError } from './errors'
import { isPlainIdentifier } from './identifier'

/** The part of a postgres.js client the engine reads: one reserved connection per transaction or statement. */
export type HyperdriveClient = Pick<PostgresJSSql, 'reserve'>

export interface HyperdriveOptions {
	/** `app_<id>`: the runtime role's default search_path, which the first connection of the isolate verifies. */
	readonly schema: string
	/** The postgres.js client of the event that runs; throws outside one. A Worker opens one per request. */
	readonly client: () => HyperdriveClient
	/**
	 * Runs on `Database#close()`. Nothing by default: a Worker ends each event's client itself. The framework's own test
	 * suites, which hold one client for a whole file, end it here.
	 */
	readonly end?: () => Promise<void>
}

/**
 * The array type of every built-in element type: postgres.js decodes none of them, so each reaches the engine as its
 * text, which the engine decodes as Bun.SQL does. User-defined arrays (an enum's) stay postgres.js's to decode.
 */
const BUILT_IN_ARRAY_TYPES: readonly number[] = [
	143,
	199,
	210,
	270,
	271,
	272,
	273,
	629,
	651,
	719,
	775,
	791,
	1000,
	1001,
	1002,
	1003,
	1005,
	1006,
	1007,
	1008,
	1009,
	1010,
	1011,
	1012,
	1013,
	1014,
	1015,
	1016,
	1017,
	1018,
	1019,
	1020,
	1021,
	1022,
	1027,
	1028,
	1034,
	1040,
	1041,
	1115,
	1182,
	1183,
	1185,
	1187,
	1231,
	1263,
	1270,
	1561,
	1563,
	2201,
	2207,
	2208,
	2209,
	2210,
	2211,
	2949,
	2951,
	3221,
	3643,
	3644,
	3645,
	3735,
	3770,
	3807,
	3905,
	3907,
	3909,
	3911,
	3913,
	3927,
	4073,
	4090,
	4097,
	4192,
	5039,
	6150,
	6151,
	6152,
	6153,
	6155,
	6157,
]

/** A postgres.js custom type, by the shape its `types` option takes: `to` and each of `from` serialize, `from` parses. */
export interface PostgresJsType {
	readonly to: number
	readonly from: number[]
	readonly serialize: (value: unknown) => string
	readonly parse: (raw: string) => string
}

/**
 * A parameter as Bun.SQL sends it unprepared, as text the server parses by the type it infers. postgres.js would
 * otherwise serialize by that type: a timestamp's text through `new Date()` (its microseconds lost), a bool's `'true'`
 * as `'f'`, a JSON text as a JSON string. A layer `Date` arrives as ISO text already (`ParameterCompiler`).
 */
function parameterText(value: unknown): string {
	if (typeof value === 'string') return value
	if (typeof value === 'boolean') return value ? 't' : 'f'
	if (value instanceof Date) return value.toISOString()
	return String(value)
}

const asIs = (raw: string): string => raw

/** A type whose parameters go as text; `from` is empty, so postgres.js still decodes its values. */
const textParameter = (to: number): PostgresJsType => Object.freeze({ to, from: [], serialize: parameterText, parse: asIs })

/**
 * What the engine's postgres.js client is opened with besides its URL and `max`: `postgres(url, { max, ...these })`.
 * Unprepared. `fetch_types` stays on: postgres.js 3.4.9 never resolves `reserve()` on a pool without an open connection
 * when it is off (porsager/postgres#1219), and Kysely reserves every connection. The array types it then fetches are
 * kept as text (`arrayText`), because its own array decoding reads a `NULL` element as the string `'NULL'`, a `bool[]`
 * as all `false`, and throws on a `json[]` holding a null; the engine decodes them. The others send their parameters as
 * text (`parameterText`).
 */
export const HYPERDRIVE_CLIENT_OPTIONS: {
	readonly prepare: false
	readonly types: Readonly<Record<string, PostgresJsType>>
} = Object.freeze({
	prepare: false,
	types: Object.freeze({
		arrayText: Object.freeze({ to: 1009, from: [...BUILT_IN_ARRAY_TYPES], serialize: parameterText, parse: asIs }),
		boolText: textParameter(16),
		byteaText: textParameter(17),
		jsonText: textParameter(114),
		jsonbText: textParameter(3802),
		dateText: textParameter(1082),
		timestampText: textParameter(1114),
		timestamptzText: textParameter(1184),
	}),
})

/** SQLSTATE `invalid_schema_name`. */
const INVALID_SCHEMA_NAME = '3F000'

/**
 * The runtime role resolves its names somewhere other than its schema: provisioning never set its default, or someone
 * changed it. A `DatabaseError`, so the session passes it on with this message rather than as a bare SQLSTATE.
 */
class SearchPathError extends DatabaseError {
	constructor(schema: string, current: string | null) {
		super(INVALID_SCHEMA_NAME)
		this.message = `the runtime role's search_path resolves to ${
			current ?? 'no schema'
		}, not ${schema}; redeploy so provisioning sets the role's default search_path`
	}
}

/** A statement ran where the runtime has no client: outside the event (a request, a job run, an alarm) that opened one. */
class NoClientError extends DatabaseError {
	constructor() {
		super(null)
		this.message = 'the database has no client here: a statement runs only inside the event (a request, a job run, an alarm) that opened one'
	}
}

/**
 * The data layer over the clients `options.client` hands out, dialect `postgres`. Every reserved connection runs
 * unprepared (`prepare: false`), whatever the dialect asks: a pooler that hands each transaction another connection
 * would not find a statement prepared on the last one. Until one connection of the isolate has passed it, each connection checks
 * `current_schema()` against `options.schema` on its own event; a mismatch fails the engine closed for every later
 * connection too. Frozen like `openPostgres`.
 */
export function openHyperdrive(options: HyperdriveOptions): Database {
	const { schema, client, end } = options
	if (!isPlainIdentifier(schema)) {
		throw new QueryRefusedError('invalid_name', 'the schema must match ^[a-z_][a-z0-9_]*$')
	}
	// Only a settled outcome is shared. The check runs on the connection of the event that reserves, and an event's I/O
	// belongs to that event: another event that awaited its in-flight check would hang with it if it were cancelled, or
	// fail with its lost connection. So until one check has passed, every connection checks itself; a few concurrent
	// events at isolate start pay one round trip each.
	let checked = false
	let refused: SearchPathError | undefined
	const verify = async (connection: PostgresJSReservedSql): Promise<void> => {
		const rows: unknown = await connection.unsafe('select current_schema() as schema', [], { prepare: false })
		const current = firstSchema(rows)
		if (current !== schema) throw new SearchPathError(schema, current)
	}
	const shim: PostgresJSSql = {
		options: {},
		end: async () => {
			await end?.()
		},
		reserve: async () => {
			if (refused !== undefined) throw refused
			let current: HyperdriveClient
			try {
				current = client()
			} catch {
				// The runtime's error may say anything; the layer passes on only its own text.
				throw new NoClientError()
			}
			const connection = await current.reserve()
			if (!checked) {
				try {
					await verify(connection)
					checked = true
				} catch (error) {
					connection.release()
					// A refused schema stays refused; a lost connection is checked again on the next one.
					if (error instanceof SearchPathError && !checked) refused = error
					throw error
				}
			}
			return unprepared(connection)
		},
	}
	return Database.fromDialect(new PostgresJSDialect({ postgres: () => shim }), { schema })
}
// Application modules load after this one: a replaced opener would receive the event's client.
Object.freeze(openHyperdrive)

function firstSchema(rows: unknown): string | null {
	if (!Array.isArray(rows)) return null
	const row: unknown = rows[0]
	if (typeof row !== 'object' || row === null) return null
	const value: unknown = Reflect.get(row, 'schema')
	return typeof value === 'string' ? value : null
}

/** The reserved connection with every statement unprepared and its array columns decoded as Bun.SQL decodes them. */
function unprepared(connection: PostgresJSReservedSql): PostgresJSReservedSql {
	return {
		release: () => connection.release(),
		unsafe: (query, parameters, queryOptions) => {
			const pending = connection.unsafe(query, parameters, { ...queryOptions, prepare: false })
			const decoded = pending.then((result) => {
				decodeArrays(result)
				return result
			})
			const wrapped = Object.assign(decoded, { cancel: () => pending.cancel() })
			// postgres.js sets the backend's pid once the statement is sent; Kysely reads it later to end the session.
			Object.defineProperty(wrapped, 'state', { get: () => pending.state })
			return wrapped
		},
	}
}

type ElementParser = (text: string) => unknown

const asText: ElementParser = (text) => text
const asNumber: ElementParser = (text) => Number(text)
const asBoolean: ElementParser = (text) => text === 't'
const asJson: ElementParser = (text) => JSON.parse(text)
const asDate: ElementParser = (text) => new Date(text)
const asBytes: ElementParser = (text) => Buffer.from(text.slice(2), 'hex')

/**
 * The array types Bun.SQL decodes, by type oid, with how it decodes their elements; any other array (`uuid[]`, a range,
 * an enum) stays its text, as there. postgres.js run with `fetch_types: false` knows no array type and returns each as
 * text, so without this a `text[]` column would read as `'{a,b}'` on Cloudflare and as `['a', 'b']` on Bun.
 */
const ARRAY_ELEMENTS: ReadonlyMap<number, ElementParser> = new Map([
	[1005, asNumber], // int2
	[1007, asNumber], // int4
	[1028, asNumber], // oid
	[1021, asNumber], // float4
	[1022, asNumber], // float8
	[1016, asText], // int8
	[1231, asText], // numeric
	[1000, asBoolean], // bool
	[1009, asText], // text
	[1015, asText], // varchar
	[1014, asText], // bpchar
	[1003, asText], // name
	[199, asJson], // json
	[3807, asJson], // jsonb
	[1182, asDate], // date
	[1115, asDate], // timestamp
	[1185, asDate], // timestamptz
	[1183, asText], // time
	[1270, asText], // timetz
	[1187, asText], // interval
	[1001, asBytes], // bytea
	[791, asText], // money
	[1041, asText], // inet
	[651, asText], // cidr
	[1040, asText], // macaddr
	[143, asText], // xml
	[1561, asText], // bit
	[1563, asText], // varbit
	[1017, asText], // point
	[1020, asText], // box, whose elements are separated by ';'
])
const BOX_ARRAY = 1020

/** Replaces, in place, each array column's text with the array; a value postgres.js already decoded is left alone. */
function decodeArrays(result: unknown): void {
	if (!Array.isArray(result)) return
	const columns: unknown = Reflect.get(result, 'columns')
	if (!Array.isArray(columns)) return
	const decoded: { readonly name: string; readonly parse: ElementParser; readonly delimiter: string }[] = []
	for (const column of columns) {
		if (typeof column !== 'object' || column === null) continue
		const name: unknown = Reflect.get(column, 'name')
		const type: unknown = Reflect.get(column, 'type')
		const parse = typeof type === 'number' ? ARRAY_ELEMENTS.get(type) : undefined
		if (typeof name === 'string' && parse !== undefined) decoded.push({ name, parse, delimiter: type === BOX_ARRAY ? ';' : ',' })
	}
	if (decoded.length === 0) return
	for (const row of result) {
		if (typeof row !== 'object' || row === null) continue
		for (const { name, parse, delimiter } of decoded) {
			const value: unknown = Reflect.get(row, name)
			if (typeof value === 'string') Reflect.set(row, name, parseArrayLiteral(value, parse, delimiter))
		}
	}
}

/**
 * Postgres' text form of an array (`{a,"b c",NULL,{1,2}}`): nested braces are nested arrays, a quoted element is
 * unescaped, an unquoted `NULL` is null. An array with other bounds than 1 (`[0:1]={1,2}`) is refused, as Bun.SQL refuses it.
 */
function parseArrayLiteral(text: string, parse: ElementParser, delimiter = ','): unknown[] {
	let position = 0
	const parseLevel = (): unknown[] => {
		if (text[position] !== '{') throw new Error('an array literal opens with "{"')
		position++
		const items: unknown[] = []
		if (text[position] === '}') {
			position++
			return items
		}
		while (position < text.length) {
			const char = text[position]
			if (char === '{') {
				items.push(parseLevel())
			} else if (char === '"') {
				position++
				let element = ''
				while (position < text.length && text[position] !== '"') {
					if (text[position] === '\\') position++
					element += text[position] ?? ''
					position++
				}
				position++
				items.push(parse(element))
			} else {
				let end = position
				while (end < text.length && text[end] !== delimiter && text[end] !== '}') end++
				const element = text.slice(position, end)
				items.push(element === 'NULL' ? null : parse(element))
				position = end
			}
			const next = text[position]
			position++
			if (next === '}') return items
			if (next !== delimiter) throw new Error('an array literal separates its elements with its delimiter')
		}
		throw new Error('an array literal closes with "}"')
	}
	return parseLevel()
}
