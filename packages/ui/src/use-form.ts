import { useCallback, useRef, useState } from 'react'
import type { FieldBinding } from './Field'

/** One problem a schema found, as Standard Schema (standardschema.dev) reports it. */
export interface StandardIssue {
	readonly message: string
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

export type StandardResult<Output> = { readonly value: Output; readonly issues?: undefined } | { readonly issues: readonly StandardIssue[] }

/**
 * The part of a Standard Schema the form reads. A zod schema is one, so the kit validates with it without depending on
 * zod.
 */
export interface StandardSchema<Input, Output> {
	readonly '~standard': {
		readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>
		readonly types?: { readonly input: Input; readonly output: Output } | undefined
	}
}

/** The fields of `V` that hold text, which a `Field` binds to an input, a select or a textarea. */
export type TextField<V> = { [K in keyof V]-?: V[K] extends string ? K : never }[keyof V] & string

/** What `form.field(name)` spreads onto a `Field`: its name, its error and the binding of its control. */
export interface FormFieldProps {
	readonly name: string
	readonly error: string | undefined
	readonly bind: FieldBinding
}

export type FormCheck<Output> = { readonly ok: true; readonly value: Output } | { readonly ok: false }

export interface FormState<Input, Output> {
	/** The values the fields show, of the schema's input type. */
	readonly values: Input
	/** The first message for each refused path (`title`, `lines.0.amount`); `''` holds what concerns no field. */
	readonly errors: Readonly<Record<string, string>>
	/** How many checks found a problem; `FormDialog` moves focus to the first refused field when it grows. */
	readonly refusals: number
	set<K extends keyof Input>(name: K, value: Input[K]): void
	field(name: TextField<Input>): FormFieldProps
	/** Validates the values with the schema: the output, or `{ ok: false }` with `errors` shown. */
	check(): Promise<FormCheck<Output>>
	/** Back to the latest initial values, with no errors. */
	reset(): void
}

/** The first message per dotted path; an issue without a path is the form's own, under `''`. */
function errorsOf(issues: readonly StandardIssue[]): Readonly<Record<string, string>> {
	const errors: Record<string, string> = {}
	for (const issue of issues) {
		const path = (issue.path ?? []).map((segment) => String(typeof segment === 'object' ? segment.key : segment)).join('.')
		errors[path] ??= issue.message
	}
	return errors
}

const NO_ERRORS: Readonly<Record<string, string>> = Object.freeze({})

/** Whether two value objects hold the same values under the same keys. */
function sameValues(left: object, right: object): boolean {
	const keys = Object.keys(left)
	return keys.length === Object.keys(right).length
		&& keys.every((key) => Object.hasOwn(right, key) && Object.is(Reflect.get(left, key), Reflect.get(right, key)))
}

/**
 * The state of a form over a schema: the values its fields show, starting at `initial`, and the schema's messages by
 * field. A field binds through `<Field label="Title" {...form.field('title')}>`. Errors appear after the first check
 * and then follow every change, so a fixed field clears at once. When `initial` holds other values (the record was
 * saved or changed meanwhile), the form starts over from them.
 */
export function useForm<Input extends object, Output>(schema: StandardSchema<Input, Output>, initial: NoInfer<Input>): FormState<Input, Output> {
	const [values, setValues] = useState(initial)
	const [errors, setErrors] = useState(NO_ERRORS)
	const [refusals, setRefusals] = useState(0)
	const [seed, setSeed] = useState(initial)
	const latest = useRef(values)
	const latestInitial = useRef(initial)
	latestInitial.current = initial
	const checked = useRef(false)
	// Only the newest validation sets the errors: an older asynchronous one may settle after it.
	const sequence = useRef(0)

	const validate = useCallback(async (next: Input): Promise<StandardResult<Output>> => {
		const call = ++sequence.current
		const result = await schema['~standard'].validate(next)
		if (call === sequence.current) setErrors(result.issues === undefined ? NO_ERRORS : errorsOf(result.issues))
		return result
	}, [schema])

	const startOver = useCallback((from: Input) => {
		sequence.current++
		checked.current = false
		latest.current = from
		setValues(from)
		setErrors(NO_ERRORS)
	}, [])

	if (!sameValues(seed, initial)) {
		setSeed(initial)
		startOver(initial)
	}

	// A bound control writes text; the schema judges it, so a literal union field is checked there, not here.
	const write = useCallback((name: PropertyKey, value: unknown) => {
		const next: Input = { ...latest.current, [name]: value }
		latest.current = next
		setValues(next)
		if (checked.current) void validate(next)
	}, [validate])
	const set = useCallback(<K extends keyof Input>(name: K, value: Input[K]) => write(name, value), [write])

	const check = useCallback(async (): Promise<FormCheck<Output>> => {
		checked.current = true
		const result = await validate(latest.current)
		if (result.issues === undefined) return { ok: true, value: result.value }
		setRefusals((count) => count + 1)
		return { ok: false }
	}, [validate])

	const reset = useCallback(() => startOver(latestInitial.current), [startOver])

	const field = (name: TextField<Input>): FormFieldProps => {
		const value = values[name]
		return {
			name,
			error: Object.hasOwn(errors, name) ? errors[name] : undefined,
			bind: { value: typeof value === 'string' ? value : '', onChange: (next) => write(name, next) },
		}
	}

	return { values, errors, refusals, set, field, check, reset }
}
