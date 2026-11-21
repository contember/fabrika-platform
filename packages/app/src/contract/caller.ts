// `ctx.caller`: the caller's own row of an application table, which the framework reads once per request before the
// handler, and the rule that refuses a person without one (403). Declared once in `defineApp`'s options; a procedure
// opts out with `caller: false`. Browser-safe and literal: `src/app-kit.ts` is part of the contract's source graph.

import type { AnyDbIndex, RowFor, Unavailable } from '@fabrika/db/tables'

/** A value a refusal compares a column with: the caller's row holds it (`equals`) or does not (`not`). */
export type CallerValue = string | number | boolean | null

/** One refusal: a row whose `column` equals (`equals`) or differs from (`not`) the value is a 403 with `message`. */
export type CallerRefusal =
	| { readonly column: string; readonly equals: CallerValue; readonly message: string }
	| { readonly column: string; readonly not: CallerValue; readonly message: string }

/**
 * `caller` of `defineApp`'s options: `table` holds one row per person, found by its `principal` column, which holds the
 * signed-in person's principal id. No row is a 403 with `missing`; a row that meets a refusal of `refuse` (first match
 * wins) is a 403 with its message. `ctx.caller` is the row, read with the table's read action.
 */
export interface CallerDeclaration {
	readonly table: string
	readonly principal: string
	readonly missing: string
	readonly refuse?: readonly CallerRefusal[]
}

/** The row `ctx.caller` holds for table `T`: what an unscoped read of it answers. */
export type CallerRow<Ix extends AnyDbIndex, T extends keyof Ix['tables']> = RowFor<Ix['tables'][T], Ix['tables'][T]['actions']['read']>

/** The columns of a row that hold text: a principal id is one. */
type TextColumn<Row> = { [C in keyof Row]: Row[C] extends string | null ? C : never }[keyof Row] & string

/** A column a refusal reads, compared with a value of its own type. */
type RefusalOf<Row> = {
	[C in keyof Row & string]:
		| { readonly column: C; readonly equals: Row[C] & CallerValue; readonly message: string }
		| { readonly column: C; readonly not: Row[C] & CallerValue; readonly message: string }
}[keyof Row & string]

/** `caller` of `defineApp`'s options, typed by the table it names. */
export interface CallerOption<Ix extends AnyDbIndex, T extends keyof Ix['tables'] & string> {
	readonly table: T
	readonly principal: TextColumn<CallerRow<Ix, T>>
	readonly missing: string
	readonly refuse?: readonly RefusalOf<CallerRow<Ix, T>>[]
}

/** `caller` of `defineApp`'s options, inferred from its optional field and then required, like a declared field. */
export type CallerField<Ix extends AnyDbIndex, T extends keyof Ix['tables'] & string> =
	& { readonly caller?: CallerOption<Ix, T> }
	& ([T] extends [never] ? unknown : { readonly caller: CallerOption<Ix, T> })

/** The kit's caller row: `never` for a kit whose options declare no `caller`. */
export type KitCallerRow<Ix extends AnyDbIndex, T extends string> = [T] extends [never] ? never
	: T extends keyof Ix['tables'] ? CallerRow<Ix, T>
	: never

/** `caller: false` of a procedure: it runs without `ctx.caller`, and nothing refuses a person without a row. */
export type CallerOptOutField<Row, Public extends boolean, Co> = Public extends true
	? { readonly caller?: Unavailable<'a public procedure has no caller row: remove caller'> }
	: [Row] extends [never] ? { readonly caller?: Unavailable<'the kit declares no caller: defineApp(vocabulary, tables, { caller })'> }
	: { readonly caller?: Co }

/**
 * `ctx.caller` of a procedure of a group for `Caller`: the person's row, `null` for any other caller kind; a message
 * where the kit declares no caller or the procedure opts out.
 */
export type CallerContext<Row, Caller extends string, Co> = [Row] extends [never]
	? { readonly caller: Unavailable<"declare caller in defineApp's options: { caller: { table, principal, missing } }"> }
	: [Co] extends [never] ? { readonly caller: Caller extends 'human' ? Row : null }
	: { readonly caller: Unavailable<'this procedure opts out of ctx.caller (caller: false)'> }

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isCallerValue = (value: unknown): value is CallerValue =>
	value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** `defineApp`'s `caller`, parsed where it enters: the types already refused what is wrong, a cast or a widened value did not. */
export function parseCallerDeclaration(value: unknown): CallerDeclaration | string[] {
	if (!isRecord(value)) {
		return ['defineApp: caller is { table, principal, missing, refuse? }']
	}
	const problems: string[] = []
	for (const key of Object.keys(value)) {
		if (!['table', 'principal', 'missing', 'refuse'].includes(key)) {
			problems.push(`defineApp: caller.${key} is not a field (allowed: table, principal, missing, refuse)`)
		}
	}
	const { table, principal, missing } = value
	if (!nonEmpty(table)) problems.push('defineApp: caller.table names a table of src/db/tables.ts')
	if (!nonEmpty(principal)) problems.push("defineApp: caller.principal names the column that holds the person's principal id")
	if (!nonEmpty(missing)) problems.push('defineApp: caller.missing is the message of the 403 for a person without a row')
	const refuse: CallerRefusal[] = []
	const rules = value['refuse']
	if (rules !== undefined && !Array.isArray(rules)) {
		problems.push('defineApp: caller.refuse is a list of { column, equals | not, message }')
	}
	for (const [index, rule] of (Array.isArray(rules) ? rules : []).entries()) {
		const parsed = refusalOf(rule)
		if (parsed === null) {
			problems.push(`defineApp: caller.refuse[${index}] is { column, equals, message } or { column, not, message }`)
		} else {
			refuse.push(parsed)
		}
	}
	if (problems.length > 0 || !nonEmpty(table) || !nonEmpty(principal) || !nonEmpty(missing)) {
		return problems
	}
	return Object.freeze({ table, principal, missing, refuse: Object.freeze(refuse) })
}

function refusalOf(rule: unknown): CallerRefusal | null {
	if (!isRecord(rule) || !nonEmpty(rule['column']) || !nonEmpty(rule['message'])) {
		return null
	}
	const keys = Object.keys(rule).sort().join(',')
	const column = rule['column']
	const message = rule['message']
	const equals = rule['equals']
	const not = rule['not']
	if (keys === 'column,equals,message' && isCallerValue(equals)) {
		return Object.freeze({ column, equals, message })
	}
	if (keys === 'column,message,not' && isCallerValue(not)) {
		return Object.freeze({ column, not, message })
	}
	return null
}

/** The message of the refusal the row meets, first match first, or `null` when it meets none. */
export function callerRefusal(declaration: CallerDeclaration, row: Readonly<Record<string, unknown>>): string | null {
	for (const rule of declaration.refuse ?? []) {
		const held = row[rule.column]
		if ('equals' in rule ? held === rule.equals : held !== rule.not) {
			return rule.message
		}
	}
	return null
}
