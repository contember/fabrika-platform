/** A refusal or failure of the runner itself. Its message names no credential; a driver error is its `cause`. */
export class PostgresMigrationError extends Error {
	override readonly name = 'PostgresMigrationError'
}
