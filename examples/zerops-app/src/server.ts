// The Zerops entrypoint — `run.start` in zerops.yaml. A long-running Bun process, not a Worker.
//
// It listens on 0.0.0.0 because the project's private network is how the proxy reaches it; it has no
// public route of its own, so binding wide is not the same as being exposed (ADR-0007).

import { SQL } from 'bun'
import { createHandler } from './app'
import { createTokenReader } from './authz'
import { readNotesEnv } from './env'
import { PostgresNotes } from './notes'

const env = readNotesEnv()
const sql = new SQL(env.databaseUrl)

const handler = createHandler({
	readCaller: createTokenReader({ issuer: env.iamIssuer, appId: env.appId }),
	notes: new PostgresNotes(sql),
})

const server = Bun.serve({
	port: env.port,
	hostname: '0.0.0.0',
	fetch: async (request) => {
		try {
			return await handler(request)
		} catch (error) {
			// Bun's default error page embeds the exception AND the surrounding source lines in the response
			// body. Log a short message only: an error object here can quote a connection string.
			console.error('unhandled request error:', error instanceof Error ? error.message : 'unknown error')
			return Response.json({ error: 'internal error' }, { status: 500 })
		}
	},
})

console.info(`notes listening on ${server.port}`)

// Zerops stops a container with SIGTERM. Draining beats being killed mid-transaction.
const shutdown = async (): Promise<void> => {
	await server.stop(false)
	await sql.close()
	process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
