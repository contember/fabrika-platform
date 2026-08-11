// The Zerops entrypoint — `run.start` in zerops.yaml. A long-running Bun process, not a Worker.
//
// It listens on 0.0.0.0 because the project's private network is how the proxy reaches it. It has no
// public route of its own, so binding wide is not the same as being exposed.

import { createBunHandler } from '@fabrika/app/bun'
import { SQL } from 'bun'
import { notesApp } from './app'
import { createTokenReader } from './authz'
import { readNotesEnv } from './env'
import { PostgresNotes } from './notes'

const env = readNotesEnv()
const sql = new SQL(env.databaseUrl)
const operationsBrowserBuild = await Bun.build({
	entrypoints: [new URL('./operations-browser.ts', import.meta.url).pathname],
	target: 'browser',
	minify: true,
})
if (!operationsBrowserBuild.success) throw new Error('failed to build the Operations SDK browser fixture')
const operationsBrowserOutput = operationsBrowserBuild.outputs[0]
if (operationsBrowserOutput === undefined) throw new Error('Operations SDK browser fixture produced no output')

const handler = createBunHandler(
	notesApp,
	{
		readCaller: createTokenReader({ issuer: env.iamIssuer, appId: env.appId }),
		notes: new PostgresNotes(sql),
		operationsBrowser: {
			dsn: env.operationsDsn,
			release: env.release,
			script: await operationsBrowserOutput.text(),
		},
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
