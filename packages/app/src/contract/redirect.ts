// `redirect()`: a procedure output that answers a redirect. The handler returns `{ to }`, and the framework answers
// 303 after a POST and 302 after a GET, to a path of the application's own origin or a URL of an origin the output
// lists; any other target fails the invocation, so no procedure is an open redirect. The value is the zod schema of
// what the handler returns, marked with the origins it lists.

import { z } from 'zod/v4'
import type { Schema } from './define'

const REDIRECT = Symbol('fabrika.redirect')

/** What `redirect()` adds to the `{ to }` schema: the origins a target may name besides the application's own. */
export interface RedirectMark {
	readonly origins: readonly string[]
}

/** The marks `redirect` made: a property another module set on a schema is no redirect. */
const marks = new WeakSet<object>()

const Target = z.strictObject({ to: z.string().min(1).max(2048) })

/** A redirect output: the handler returns `{ to }`, and the caller receives a 303 or a 302 there. */
export type Redirect = typeof Target & RedirectBrand

/** What tells a redirect output from a JSON one in the types. */
export interface RedirectBrand {
	readonly [REDIRECT]: RedirectMark
}

export interface RedirectOptions {
	/** Exact `https://` origins a target may name, besides the application's own: `['https://shop.example']`. */
	readonly origins?: readonly string[]
}

/** The output of a procedure that answers a redirect. `compileContract` and the checker refuse an origin it may not list. */
export function redirect(options: RedirectOptions = {}): Redirect {
	const mark: RedirectMark = Object.freeze({ origins: Object.freeze([...(options.origins ?? [])]) })
	marks.add(mark)
	return Object.assign(Target.clone(), { [REDIRECT]: mark })
}

/** The mark of a `redirect()` output, or `null` for any other schema. */
export function redirectOf(schema: Schema): RedirectMark | null {
	const mark: unknown = Reflect.get(schema, REDIRECT)
	return isMark(mark) ? mark : null
}

function isMark(value: unknown): value is RedirectMark {
	return typeof value === 'object' && value !== null && marks.has(value)
}
