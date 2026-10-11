// A routine's identity is its name and its input argument types (Postgres overloading), written as the catalog
// writes them: `pg_type.typname` of each `proargtypes` entry, comma-separated (`f(int4,_text)`). Runtime-neutral.

import { type SqlToken, upperWord } from './migration-sql'
import { isName, isPunct, nameText, splitAtCommas } from './sql-names'

/** SQL spellings of the built-in types, by their `typname`. A spelling not listed is its own name (an enum's). */
const TYPE_NAMES: Readonly<Record<string, string>> = {
	int: 'int4',
	integer: 'int4',
	int4: 'int4',
	smallint: 'int2',
	int2: 'int2',
	bigint: 'int8',
	int8: 'int8',
	real: 'float4',
	float4: 'float4',
	'double precision': 'float8',
	float8: 'float8',
	float: 'float8',
	numeric: 'numeric',
	decimal: 'numeric',
	dec: 'numeric',
	boolean: 'bool',
	bool: 'bool',
	varchar: 'varchar',
	'character varying': 'varchar',
	'char varying': 'varchar',
	char: 'bpchar',
	character: 'bpchar',
	bpchar: 'bpchar',
	timestamp: 'timestamp',
	'timestamp without time zone': 'timestamp',
	timestamptz: 'timestamptz',
	'timestamp with time zone': 'timestamptz',
	time: 'time',
	'time without time zone': 'time',
	timetz: 'timetz',
	'time with time zone': 'timetz',
	bit: 'bit',
	'bit varying': 'varbit',
	varbit: 'varbit',
	interval: 'interval',
}

/** Words that begin a type spelled in more than one word, so a leading one is no argument name. */
const MULTI_WORD_STARTS: ReadonlySet<string> = new Set(['double', 'character', 'char', 'timestamp', 'time', 'bit', 'interval'])

const MODES: ReadonlySet<string> = new Set(['IN', 'OUT', 'INOUT', 'VARIADIC'])

/** One argument type as its `typname`, or `undefined` when the classifier cannot name it (`t.c%TYPE`). */
function typeName(tokens: readonly SqlToken[], schema: string): string | undefined {
	let depth = 0
	let array = false
	let modifier = ''
	const words: SqlToken[] = []
	for (const [index, token] of tokens.entries()) {
		if (isPunct(token, '(')) depth++
		else if (isPunct(token, ')')) depth--
		else if (depth > 0) modifier += token.kind === 'punct' ? token.char : ' '
		else if (isPunct(token, '[') || upperWord(token) === 'ARRAY') array = true
		else if (isPunct(token, ']') || (token.kind === 'punct' && /[0-9]/.test(token.char))) continue
		else if (isPunct(token, '.') && isName(tokens[index - 1]) && isName(tokens[index + 1])) {
			// `schema.type`: only the application's own schema names a type here.
			if (nameText(tokens[index - 1]) !== schema) return undefined
			words.pop()
		} else if (isName(token)) words.push(token)
		else return undefined
	}
	const first = words[0]
	if (first === undefined) return undefined
	let base: string | undefined
	if (words.length === 1) {
		const name = nameText(first) ?? ''
		base = first.kind === 'quoted' ? name : Object.hasOwn(TYPE_NAMES, name) ? TYPE_NAMES[name] : name
		// `float(p)` is `real` up to 24 bits of precision.
		if (name === 'float' && /^[0-9]+$/.test(modifier) && Number(modifier) <= 24) base = 'float4'
	} else if (words.every((word) => word.kind === 'word')) {
		const spelled = words.map((word) => nameText(word)).join(' ')
		base = spelled.startsWith('interval ') ? 'interval' : Object.hasOwn(TYPE_NAMES, spelled) ? TYPE_NAMES[spelled] : undefined
	}
	if (base === undefined) return undefined
	return array ? `_${base}` : base
}

/**
 * The input signature of a routine's argument list (the tokens between its parentheses), as `proargtypes` holds it:
 * `int4,text`, without `OUT` arguments. `undefined` when an argument type cannot be named.
 */
export function routineSignature(args: readonly SqlToken[], schema: string): string | undefined {
	if (args.length === 0) return ''
	const types: string[] = []
	for (const argument of splitAtCommas(args)) {
		let tokens = argument
		const defaultAt = tokens.findIndex((token) => upperWord(token) === 'DEFAULT' || isPunct(token, '='))
		if (defaultAt !== -1) tokens = tokens.slice(0, defaultAt)
		const mode = upperWord(tokens[0])
		if (mode !== undefined && MODES.has(mode) && tokens.length > 1) tokens = tokens.slice(1)
		if (mode === 'OUT') continue
		const whole = typeName(tokens, schema)
		const startsType = tokens[0]?.kind === 'word' && MULTI_WORD_STARTS.has(nameText(tokens[0]) ?? '') && whole !== undefined
		const unnamed = tokens.length === 1 || !isName(tokens[1]) || startsType
		const type = unnamed ? whole : typeName(tokens.slice(1), schema)
		if (type === undefined) return undefined
		types.push(type)
	}
	return types.join(',')
}
