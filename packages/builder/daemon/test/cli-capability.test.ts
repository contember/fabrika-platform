import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_CLI_TOKEN_QUERY, builderDaemonUrl } from '../../shared/urls'
import { type RunningDaemon, startDaemon } from '../src/index'
import { scratchDir } from './scratch'

let daemon: RunningDaemon
let directory: string
let cliAuthFile: string
let base: string
let token: string

beforeAll(() => {
	directory = scratchDir('builder-cli-capability-')
	cliAuthFile = join(directory, 'tmp', 'fabrika', 'daemon-auth-token')
	daemon = startDaemon({ port: 0, sessionsDir: join(directory, 'sessions'), cliAuthFile })
	base = builderDaemonUrl(daemon.port)
	token = readFileSync(cliAuthFile, 'utf-8')
})

afterAll(() => {
	daemon.stop()
	rmSync(directory, { recursive: true, force: true })
})

/** A directory of another tool's credentials, standing in for one under the developer's home. */
function credentialsDirectory(name: string): string {
	const root = join(directory, name)
	mkdirSync(root, { recursive: true })
	writeFileSync(join(root, 'credentials'), 'dummy-credential')
	return root
}

function canvasDirectory(name: string): string {
	const canvas = join(directory, name)
	mkdirSync(canvas, { recursive: true })
	writeFileSync(join(canvas, 'view.jsx'), '<Section title="Plan">body</Section>')
	return canvas
}

function pushPlan(sessionId: string, projectRoot: string, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${base}/api/session/${sessionId}/plan`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify({ directory: canvasDirectory(`canvas-${sessionId}`), projectRoot }),
	})
}

test('the daemon writes its CLI capability where only its owner reads it', () => {
	expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
	expect(statSync(cliAuthFile).mode & 0o777).toBe(0o600)
	expect(statSync(join(directory, 'tmp', 'fabrika')).mode & 0o777).toBe(0o700)
})

test('a local client without the capability cannot bind a session to a directory and read a file through it', async () => {
	const secrets = credentialsDirectory('foreign-credentials')
	const push = await pushPlan('stolen', secrets)
	expect(push.status).toBe(401)
	const read = await fetch(`${base}/api/session/stolen/artifact?path=credentials`)
	expect(read.status).toBe(404)
	expect(await read.text()).not.toContain('dummy-credential')

	const forged = await pushPlan('stolen', secrets, { [BUILDER_CLI_TOKEN_HEADER]: `${token.slice(0, -1)}x` })
	expect(forged.status).toBe(401)
})

test('every route only the CLI calls requires the capability', async () => {
	const refused = [
		['POST', '/api/session/any/feedback/consume'],
		['POST', '/api/session/any/gate/vision/consume'],
		['POST', '/api/session/any/reset'],
		['POST', '/api/build/event'],
	] as const
	for (const [method, path] of refused) {
		const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: '{"status":"started"}' })
		expect({ path, status: response.status }).toEqual({ path, status: 401 })
	}
	const upgrade = await fetch(`${base}/ws/wait/any`, { headers: { Upgrade: 'websocket', Connection: 'Upgrade' } })
	expect(upgrade.status).toBe(401)
})

test('the CLI flow works with the capability', async () => {
	const project = credentialsDirectory('own-project')
	const push = await pushPlan('owned', project, { [BUILDER_CLI_TOKEN_HEADER]: token })
	expect(push.status).toBe(200)
	const read = await fetch(`${base}/api/session/owned/artifact?path=credentials`)
	expect(await read.json()).toEqual({ path: 'credentials', content: 'dummy-credential' })

	const consumed = await fetch(`${base}/api/session/owned/feedback/consume`, { method: 'POST', headers: { [BUILDER_CLI_TOKEN_HEADER]: token } })
	expect(consumed.status).not.toBe(401)

	const socket = new WebSocket(`${builderDaemonUrl(daemon.port, 'ws')}/ws/wait/owned?${BUILDER_CLI_TOKEN_QUERY}=${encodeURIComponent(token)}`)
	const opened = await new Promise<boolean>((resolve) => {
		socket.onopen = () => resolve(true)
		socket.onerror = () => resolve(false)
	})
	socket.close()
	expect(opened).toBe(true)
})
