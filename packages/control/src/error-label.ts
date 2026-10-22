// What a log line may say about an unexpected failure: its class, and for a database error the fields that locate it.
// Never the message or the detail: a GitHub, provider or SQL error may carry a value, a URL or a credential.

/** The SQL error fields that name a place in the schema or the server, never a value. */
const LOCATING_FIELDS = ['errno', 'routine', 'table', 'column', 'constraint', 'dataType', 'position'] as const

export function errorLabel(cause: unknown): string {
	if (!(cause instanceof Error)) return 'unknown error'
	const located = LOCATING_FIELDS.flatMap((field) => {
		const value: unknown = Reflect.get(cause, field)
		return typeof value === 'string' || typeof value === 'number' ? [`${field}=${value}`] : []
	})
	return [cause.name, ...located].join(' ')
}
