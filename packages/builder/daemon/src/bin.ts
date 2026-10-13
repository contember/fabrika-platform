#!/usr/bin/env bun

import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { activeDaemonSchema, builderDaemonUrl } from '../../shared'
import { startDaemon } from './index'
import { PID_FILE, SESSIONS_DIR, TEMP_DIR } from './paths'

const port = parseInt(process.env['FABRIKA_PORT'] || '19410', 10)

interface ActiveDaemon {
	ok: boolean
	sessionsDir: string
}

function parseActiveDaemon(value: unknown): ActiveDaemon | null {
	const result = activeDaemonSchema.safeParse(value)
	return result.success ? result.data : null
}

async function activeDaemon(): Promise<ActiveDaemon | null> {
	try {
		const res = await fetch(`${builderDaemonUrl(port)}/health`, {
			signal: AbortSignal.timeout(1000),
		})
		const data: unknown = await res.json()
		return parseActiveDaemon(data)
	} catch {
		return null
	}
}

const active = await activeDaemon()
if (active) {
	if (resolve(active.sessionsDir) === resolve(SESSIONS_DIR)) {
		console.log(`fabrika daemon already running on ${builderDaemonUrl(port)} — not starting a second.`)
		process.exit(0)
	}
	console.error(
		`fabrika daemon on :${port} uses ${active.sessionsDir}; `
			+ `requested ${SESSIONS_DIR}. Stop it before starting this daemon.`,
	)
	process.exit(1)
}

let boundPort: number
try {
	;({ port: boundPort } = startDaemon({ port }))
} catch (error: unknown) {
	console.error(`fabrika daemon failed to bind :${port}: ${error instanceof Error ? error.message : String(error)}`)
	process.exit(1)
}

mkdirSync(TEMP_DIR, { recursive: true })
writeFileSync(PID_FILE, String(process.pid))

console.log(`fabrika daemon listening on ${builderDaemonUrl(boundPort)}`)

function shutdown() {
	try {
		rmSync(PID_FILE, { force: true })
	} catch {
	}
	process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
