// Every refusal a page meets, as one union it can switch on: the proxy's 401 with the login URL, a 403, a stale
// `expectVersion` (409), a refused input with its field paths, a 404, and everything else.

export type FabrikaError =
	| {
		readonly kind: 'unauthenticated'
		readonly message: string
		/** Where the proxy sends the person to sign in; `null` when the answer carried none. */
		readonly loginUrl: string | null
	}
	| { readonly kind: 'forbidden'; readonly message: string }
	| { readonly kind: 'conflict'; readonly message: string }
	| {
		readonly kind: 'validation'
		readonly message: string
		/** The first message for each refused field, by its dotted input path (`title`, `lines.0.amount`). */
		readonly fields: Readonly<Record<string, string>>
	}
	| { readonly kind: 'not-found'; readonly message: string }
	| {
		readonly kind: 'other'
		readonly message: string
		/** The HTTP status; `0` when the request never got an answer. */
		readonly status: number
	}

export type FabrikaErrorKind = FabrikaError['kind']

interface Issue {
	readonly path: string
	readonly message: string
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null
}

/** The `{ path, message }` issues of a 400; anything else in `issues` is ignored. */
function issuesOf(value: unknown): readonly Issue[] {
	if (!Array.isArray(value)) {
		return []
	}
	return value.flatMap((issue: unknown) => {
		if (!isRecord(issue)) return []
		const path = issue['path']
		const message = issue['message']
		return typeof path === 'string' && typeof message === 'string' ? [{ path, message }] : []
	})
}

/** The first message per path: a field shows one line. */
export function fieldsOf(issues: readonly Issue[]): Readonly<Record<string, string>> {
	const fields: Record<string, string> = {}
	for (const issue of issues) {
		fields[issue.path] ??= issue.message
	}
	return Object.freeze(fields)
}

/**
 * A refused call as the union, read structurally off the client's `RpcError` (`httpStatus`, `type`, `issues`,
 * `loginUrl`); any other thrown value (a bug in the page) is `other` with status `0`.
 */
export function toFabrikaError(error: unknown): FabrikaError {
	const message = error instanceof Error ? error.message : 'Something went wrong'
	const status = isRecord(error) && typeof error['httpStatus'] === 'number' ? error['httpStatus'] : 0
	const type = isRecord(error) ? error['type'] : undefined
	if (status === 401 || type === 'auth') {
		const loginUrl = isRecord(error) ? error['loginUrl'] : undefined
		return { kind: 'unauthenticated', message, loginUrl: typeof loginUrl === 'string' ? loginUrl : null }
	}
	if (status === 403) return { kind: 'forbidden', message }
	if (status === 404) return { kind: 'not-found', message }
	if (status === 409) return { kind: 'conflict', message }
	if (status === 400) return { kind: 'validation', message, fields: fieldsOf(issuesOf(isRecord(error) ? error['issues'] : undefined)) }
	return { kind: 'other', message, status }
}

/** The message for one field of a validation error, or `undefined`: what a form shows under that field. */
export function fieldError(error: FabrikaError | null, path: string): string | undefined {
	return error?.kind === 'validation' ? error.fields[path] : undefined
}
