// Configuration, read once at boot and validated LOUDLY.
//
// A service that boots half-configured and then denies every request at 3am is strictly worse than one
// that never came up: the second is a deploy failure with a message, the first is an incident. So every
// required value is read here and a missing one throws before anything listens.
//
// Nothing in this file ever logs a value. Only the ABSENCE of a credential is reportable.

export interface NotesEnv {
	port: number
	/** Postgres, on the DIRECT port. From `${notesdb_connectionString}` — see zerops.yaml. */
	databaseUrl: string
	/**
	 * The IAM service's public origin: the `iss` of every token this app verifies and the base of the
	 * JWKS it fetches. Per-environment, so it is a service-level variable rather than a committed one.
	 */
	iamIssuer: string
	/** This app's id — the `aud` a token must carry to be accepted here. */
	appId: string
}

export const readNotesEnv = (source: Record<string, string | undefined> = process.env): NotesEnv => ({
	port: port(source['PORT']),
	databaseUrl: required(source, 'NOTES_DATABASE_URL'),
	iamIssuer: required(source, 'FABRIKA_IAM_ISSUER'),
	appId: required(source, 'NOTES_APP_ID'),
})

/**
 * Just the database URL — what `migrate.ts` needs. The migration runs before the service serves
 * anything, so demanding IAM's origin there would make a missing IAM setting fail the CONTAINER START
 * rather than the first request, which reports the wrong problem.
 */
export const readDatabaseUrl = (source: Record<string, string | undefined> = process.env): string => required(source, 'NOTES_DATABASE_URL')

const required = (source: Record<string, string | undefined>, name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') {
		throw new Error(`${name} is required`)
	}
	return value
}

const port = (raw: string | undefined): number => {
	if (raw === undefined || raw.trim() === '') {
		return 3000
	}
	const value = Number.parseInt(raw, 10)
	if (!Number.isInteger(value) || value < 1 || value > 65535) {
		throw new Error('PORT must be an integer between 1 and 65535')
	}
	return value
}
