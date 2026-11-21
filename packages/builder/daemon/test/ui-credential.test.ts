import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_CLI_TOKEN_QUERY, BUILDER_DAEMON_HOST, builderDaemonUrl } from '../../shared/urls'
import { type RunningDaemon, startDaemon } from '../src/index'
import { scratchDir } from './scratch'

/**
 * The dashboard's routes as another local process or OS user reaches them: without the UI cookie or the CLI capability
 * every one is refused. The link the CLI hands out sets the cookie, and the CLI keeps working on its capability.
 */

const SESSION = 'owned'

let daemon: RunningDaemon
let directory: string
let uiTokenFile: string
let cliAuthFile: string
let base: string
let token: string

/** Every route and upgrade the dashboard calls, with a body where the route reads one. */
const DASHBOARD_ROUTES: ReadonlyArray<readonly [method: string, path: string, body?: string]> = [
	['GET', '/'],
	['GET', `/s/${SESSION}`],
	['GET', '/api/sessions'],
	['GET', `/api/phase?session=${SESSION}`],
	['GET', `/api/session/${SESSION}/meta`],
	['GET', `/api/session/${SESSION}/artifact?path=notes.md`],
	['GET', `/api/session/${SESSION}/canvas/view.jsx`],
	['GET', `/api/session/${SESSION}/skeletons`],
	['GET', `/api/session/${SESSION}/revision/1/feedback`],
	['GET', `/api/session/${SESSION}/revision/1/responses`],
	['PUT', `/api/session/${SESSION}/revision/1/responses`, '{"answers":[]}'],
	['GET', '/api/build/stream'],
	['GET', `/api/project/${SESSION}/platform`],
	['POST', `/api/project/${SESSION}/register`, '{}'],
	['POST', `/api/project/${SESSION}/connect`, '{"controlOrigin":"https://control.example"}'],
	['POST', `/api/project/${SESSION}/disconnect`, '{}'],
	['POST', `/api/project/${SESSION}/deploy`, '{}'],
	['POST', `/api/project/${SESSION}/preview`, '{"url":null}'],
]

function start(port: number): RunningDaemon {
	const data = join(directory, 'data')
	return startDaemon({
		port,
		sessionsDir: join(data, 'sessions'),
		cliAuthFile,
		uiTokenFile,
		platform: { dataDir: data, stateDir: join(data, 'projects'), credentialDir: join(directory, 'credentials') },
	})
}

beforeAll(async () => {
	directory = scratchDir('builder-ui-credential-')
	uiTokenFile = join(directory, 'data', 'ui-token')
	cliAuthFile = join(directory, 'tmp', 'fabrika', 'daemon-auth-token')
	mkdirSync(join(directory, 'data'), { recursive: true, mode: 0o700 })
	mkdirSync(join(directory, 'credentials'), { mode: 0o700 })
	daemon = start(0)
	base = builderDaemonUrl(daemon.port)
	token = readFileSync(cliAuthFile, 'utf-8')
	const project = join(directory, 'project')
	mkdirSync(join(project, 'canvas'), { recursive: true })
	mkdirSync(join(project, '.fabrika'))
	writeFileSync(
		join(project, '.fabrika', 'config.json'),
		JSON.stringify({ profile: 'app', sessionId: SESSION, createdAt: '2026-09-21T10:00:00.000Z' }),
	)
	writeFileSync(join(project, 'notes.md'), 'dummy-project-notes')
	writeFileSync(join(project, 'canvas', 'view.jsx'), '<Section title="Plan">body</Section>')
	const push = await pushPlan()
	expect(push.status).toBe(200)
})

afterAll(() => {
	daemon.stop()
	rmSync(directory, { recursive: true, force: true })
})

function pushPlan(): Promise<Response> {
	const project = join(directory, 'project')
	return fetch(`${base}/api/session/${SESSION}/plan`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', [BUILDER_CLI_TOKEN_HEADER]: token },
		body: JSON.stringify({ directory: join(project, 'canvas'), projectRoot: project }),
	})
}

/** The status a route answers; a stream is cancelled once its status is known. */
async function status(method: string, path: string, body: string | undefined, headers: Record<string, string>): Promise<number> {
	const response = await fetch(`${base}${path}`, {
		method,
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
		...(body === undefined ? {} : { body }),
		redirect: 'manual',
	})
	await response.body?.cancel()
	return response.status
}

function socketOpens(url: string): Promise<boolean> {
	const socket = new WebSocket(url)
	return new Promise<boolean>((resolve) => {
		socket.onopen = () => {
			socket.close()
			resolve(true)
		}
		socket.onerror = () => resolve(false)
	})
}

/**
 * The status a browser's upgrade of the session socket gets, sent raw: the DOM `WebSocket` the tests are typed against
 * takes no headers, and a browser sends its cookie on the upgrade.
 */
function upgradeStatus(headers: Record<string, string>): Promise<number> {
	return new Promise((done, fail) => {
		const socket = connect(daemon.port, BUILDER_DAEMON_HOST, () => {
			const lines = [
				`GET /ws/session/${SESSION} HTTP/1.1`,
				`Host: ${BUILDER_DAEMON_HOST}:${daemon.port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Version: 13',
				`Sec-WebSocket-Key: ${btoa('0123456789abcdef')}`,
				...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
			]
			socket.write(`${lines.join('\r\n')}\r\n\r\n`)
		})
		socket.once('data', (chunk) => {
			socket.destroy()
			done(Number(String(chunk).split(' ')[1]))
		})
		socket.once('error', fail)
	})
}

function browserUrlOf(body: unknown): string {
	if (typeof body !== 'object' || body === null || !('browserUrl' in body) || typeof body.browserUrl !== 'string') {
		throw new Error('The response carries no browserUrl')
	}
	return body.browserUrl
}

async function issueLink(): Promise<string> {
	const response = await fetch(`${base}/api/session/${SESSION}/link`, { method: 'POST', headers: { [BUILDER_CLI_TOKEN_HEADER]: token } })
	expect(response.status).toBe(200)
	return browserUrlOf(await response.json())
}

/** Follows a link as a browser does; `cookie` is the cookie it set, as a `Cookie` header value. */
async function redeem(link: string): Promise<{ status: number; cookie: string; setCookie: string | null; body: string }> {
	const response = await fetch(link, { redirect: 'manual' })
	const setCookie = response.headers.get('Set-Cookie')
	return { status: response.status, cookie: setCookie?.split(';')[0] ?? '', setCookie, body: await response.text() }
}

test('without the cookie or the CLI capability every dashboard route and the session socket are refused', async () => {
	for (const [method, path, body] of DASHBOARD_ROUTES) {
		expect({ method, path, status: await status(method, path, body, {}) }).toEqual({ method, path, status: 401 })
	}
	expect(await upgradeStatus({})).toBe(401)
	expect(await socketOpens(`${builderDaemonUrl(daemon.port, 'ws')}/ws/session/${SESSION}`)).toBe(false)
})

test('a page without the cookie names the command that prints a fresh link', async () => {
	const response = await fetch(`${base}/s/${SESSION}`)
	expect(response.status).toBe(401)
	expect(response.headers.get('Content-Type')).toContain('text/html')
	expect(await response.text()).toContain('fabrika builder dashboard')
})

test('liveness, assets and the link route answer without a credential', async () => {
	expect(await status('GET', '/health', undefined, {})).toBe(200)
	expect(await status('GET', '/assets/missing.js', undefined, {})).toBe(404)
	expect(await status('GET', '/open?code=unknown', undefined, {})).toBe(401)
})

test('only the CLI gets a link, and a pushed canvas answers with one', async () => {
	expect(await status('POST', `/api/session/${SESSION}/link`, undefined, {})).toBe(401)
	const push = await pushPlan()
	expect(browserUrlOf(await push.json())).toMatch(new RegExp(`^${base}/open\\?code=[A-Za-z0-9_-]{32}$`))
})

test('the link sets the cookie once, and the dashboard routes and the socket then answer', async () => {
	const link = await issueLink()
	expect(link.startsWith(`${base}/open?code=`)).toBe(true)
	const first = await redeem(link)
	expect(first.status).toBe(200)
	expect(first.setCookie).toContain('HttpOnly')
	expect(first.setCookie).toContain('SameSite=Strict')
	expect(first.cookie).toMatch(new RegExp(`^fabrika-builder-ui-${daemon.port}=`))
	expect(first.body).toContain(`url=/s/${SESSION}`)

	for (const [method, path, body] of DASHBOARD_ROUTES) {
		const refused = await status(method, path, body, { Cookie: first.cookie }) === 401
		expect({ method, path, refused }).toEqual({ method, path, refused: false })
	}
	const artifact = await fetch(`${base}/api/session/${SESSION}/artifact?path=notes.md`, { headers: { Cookie: first.cookie } })
	expect(await artifact.json()).toEqual({ path: 'notes.md', content: 'dummy-project-notes' })
	expect(await upgradeStatus({ Cookie: first.cookie })).toBe(101)

	const replay = await redeem(link)
	expect(replay.status).toBe(401)
	expect(replay.setCookie).toBeNull()
	expect(await status('GET', '/api/sessions', undefined, { Cookie: `${first.cookie.slice(0, -1)}x` })).toBe(401)
})

test('the CLI flow keeps working on its capability: reads, push, wait, gate consume', async () => {
	const cli = { [BUILDER_CLI_TOKEN_HEADER]: token }
	expect(await status('GET', `/api/phase?session=${SESSION}`, undefined, cli)).toBe(200)
	expect(await status('GET', `/api/session/${SESSION}/meta`, undefined, cli)).toBe(200)
	const register = JSON.stringify({ projectRoot: join(directory, 'project') })
	expect(await status('POST', `/api/project/${SESSION}/register`, register, cli)).toBe(200)
	expect(await status('GET', `/api/project/${SESSION}/platform`, undefined, cli)).toBe(200)
	expect((await pushPlan()).status).toBe(200)
	const wait = `${builderDaemonUrl(daemon.port, 'ws')}/ws/wait/${SESSION}?${BUILDER_CLI_TOKEN_QUERY}=${encodeURIComponent(token)}`
	expect(await socketOpens(wait)).toBe(true)
	expect(await status('POST', `/api/session/${SESSION}/gate/vision/consume`, undefined, cli)).not.toBe(401)
})

test('the UI secret is readable by its owner only and survives a restart', async () => {
	expect(statSync(uiTokenFile).mode & 0o777).toBe(0o600)
	const { cookie } = await redeem(await issueLink())
	const port = daemon.port
	daemon.stop()
	daemon = start(port)
	expect(await status('GET', '/api/sessions', undefined, { Cookie: cookie })).toBe(200)
})
