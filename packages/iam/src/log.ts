/**
 * The ONE place IAM turns a caught value into a log line.
 *
 * The package invariant is that a secret, a key, or an error object that may quote a connection
 * string never reaches a log. `console.error('…', err)` breaks it silently: a driver error carries
 * the DSN it failed to connect with, and a fetch error carries the URL — which, on the mint path, is
 * an IAM address with a shared secret in a header the runtime may attach to the message. Only the
 * MESSAGE crosses this boundary, and only when it is a real `Error`; anything else is reported by
 * shape alone. See SEC-8.
 */
export function logError(message: string, cause: unknown): void {
	console.error(`${message}: ${describeError(cause)}`)
}

/** The same rule for a recoverable condition — a path that carried on after catching. */
export function logWarn(message: string, cause: unknown): void {
	console.warn(`${message}: ${describeError(cause)}`)
}

/** The safe half of a caught value: an `Error`'s own message, otherwise its type and nothing else. */
export function describeError(cause: unknown): string {
	if (cause instanceof Error) {
		return cause.message
	}
	return `non-error ${typeof cause}`
}
