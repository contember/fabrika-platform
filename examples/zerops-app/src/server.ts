// The Zerops entrypoint — `run.start` in zerops.yaml. A long-running Bun process, not a Worker.
//
// It listens on 0.0.0.0 because the project's private network is how the proxy reaches it; it has no
// public route of its own, so binding wide is not the same as being exposed (ADR-0007).

import { createBunHandler } from '@fabrika/app/bun'
import { SQL } from 'bun'
import { notesApp } from './app'
import { createTokenReader } from './authz'
import { readNotesEnv } from './env'
import { PostgresNotes } from './notes'

const env = readNotesEnv()
const sql = new SQL(env.databaseUrl)

const handler = createBunHandler(
	notesApp,
	{
		readCaller: createTokenReader({ issuer: env.iamIssuer, appId: env.appId }),
		notes: new PostgresNotes(sql),
		onError: () => console.error('unhandled request error'),
	},
	{ onBackgroundError: () => console.error('background task failed') },
)

const server = Bun.serve({
	port: env.port,
	hostname: '0.0.0.0',
	fetch: handler.fetch,
})

console.info(`notes listening on ${server.port}`)

// Zerops stops a container with SIGTERM. Draining beats being killed mid-transaction.
const shutdown = async (): Promise<void> => {
	await server.stop(false)
	await handler.drain()
	await sql.close()
	process.exit(0)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
