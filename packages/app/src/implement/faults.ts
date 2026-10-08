// The framework's own failures. A `ServerFault` message is safe for the server log, never for the response: the
// envelope of every 5xx is fixed (`dispatch.ts`'s `errorResponse`).

/** A failure the framework itself describes; its message is safe for the server log, never for the response. */
export class ServerFault extends Error {
	override readonly name = 'ServerFault'
	readonly status: number

	constructor(message: string, status = 500) {
		super(message)
		this.status = status
	}
}
