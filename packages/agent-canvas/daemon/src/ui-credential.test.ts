import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { CLI_TOKEN_QUERY } from './admission'

/**
 * The daemon and the CLI as a user runs them, on a port and in a home and temp directory of their own: the UI's routes
 * need the credential the CLI's link hands the browser, and the CLI keeps working on its own capability.
 */

const CLI = resolve(import.meta.dir, '..', '..', 'bin', 'agent-canvas.ts')
const SESSION = 'ui-credential-demo'

const root = mkdtempSync(join(tmpdir(), 'agent-canvas-ui-credential-'))
const home = join(root, 'home')
const temp = join(root, 'tmp')
const project = join(root, 'project')
const canvases = join(root, 'canvases')
const fakeBin = join(root, 'bin')
const opened = join(root, 'opened-urls')
let port = 0
let base = ''

function freePort(): number {
	const probe = Bun.serve({ port: 0, hostname: 'localhost', fetch: () => new Response(null) })
	const found = probe.port
	probe.stop(true)
	if (found === undefined) throw new Error('no free port')
	return found
}

function environment(): Record<string, string> {
	return {
		...process.env,
		HOME: home,
		TMPDIR: temp,
		CANVAS_PORT: String(port),
		CANVAS_SESSION_ID: SESSION,
		CANVAS_PROJECT_ROOT: project,
		CANVAS_TIMEOUT: '20000',
		// The fake opener records the URL a command hands the browser instead of opening one.
		PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
	}
}

async function cli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, CLI, ...args], { env: environment(), cwd: project, stdout: 'pipe', stderr: 'pipe' })
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { exitCode, stdout, stderr }
}

function openedUrls(): string[] {
	return existsSync(opened) ? readFileSync(opened, 'utf-8').split('\n').filter((line) => line !== '') : []
}

function cookiePair(response: Response): string {
	const setCookie = response.headers.get('Set-Cookie')
	if (setCookie === null) throw new Error('no Set-Cookie')
	return setCookie.split(';')[0] ?? ''
}

/**
 * The status a browser's WebSocket upgrade gets, sent raw: the DOM `WebSocket` the tests are typed against takes no
 * headers, and the browser sends its cookie on the upgrade.
 */
function upgradeStatus(path: string, headers: Record<string, string>): Promise<number> {
	return new Promise((done, fail) => {
		const socket = connect(port, 'localhost', () => {
			const lines = [
				`GET ${path} HTTP/1.1`,
				`Host: localhost:${port}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				'Sec-WebSocket-Version: 13',
				`Sec-WebSocket-Key: ${btoa('0123456789abcdef')}`,
				`Origin: ${base}`,
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

/** Submits feedback on a browser socket and resolves once the daemon has saved it (it then announces the revision). */
function submitFeedback(feedback: string): Promise<void> {
	return new Promise((done, fail) => {
		const token = readFileSync(join(temp, 'agent-canvas', 'daemon-auth-token'), 'utf-8')
		const socket = new WebSocket(`ws://localhost:${port}/ws/session/${SESSION}?${CLI_TOKEN_QUERY}=${token}`)
		socket.onopen = () => socket.send(JSON.stringify({ type: 'submit', feedback }))
		socket.onmessage = (event) => {
			if (!String(event.data).includes('"revision-updated"')) return
			socket.close()
			done()
		}
		socket.onerror = () => fail(new Error('browser socket refused'))
	})
}

beforeAll(async () => {
	for (const dir of [home, temp, project, canvases, fakeBin]) mkdirSync(dir, { recursive: true })
	writeFileSync(join(fakeBin, 'xdg-open'), `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`)
	chmodSync(join(fakeBin, 'xdg-open'), 0o755)
	writeFileSync(join(project, 'notes.txt'), 'project notes')
	writeFileSync(join(canvases, 'plan.jsx'), 'export default function Plan() { return <Section title="Demo">Hello</Section> }\n')
	port = freePort()
	base = `http://localhost:${port}`
	const pushed = await cli(['push', canvases, '--label', 'Demo'])
	if (pushed.exitCode !== 0) throw new Error(`push failed: ${pushed.stderr}`)
}, 60_000)

afterAll(async () => {
	await cli(['daemon', 'stop'])
	rmSync(root, { recursive: true, force: true })
})

describe('the canvas UI credential', () => {
	test('the UI routes refuse a client without it', async () => {
		const file = `${base}/api/file?session=${SESSION}&path=${encodeURIComponent(join(project, 'notes.txt'))}`
		expect((await fetch(file)).status).toBe(401)
		expect((await fetch(`${base}/api/sessions`)).status).toBe(401)
		expect((await fetch(`${base}/api/session/${SESSION}/meta`)).status).toBe(401)
		expect(await upgradeStatus(`/ws/session/${SESSION}`, {})).toBe(401)
		const root = await fetch(`${base}/`, { redirect: 'manual' })
		expect(root.status).toBe(401)
		expect(root.headers.get('Location')).toBeNull()
	})

	test('a page without it names the command that prints a fresh link', async () => {
		const page = await fetch(`${base}/s/${SESSION}`)
		expect(page.status).toBe(401)
		expect(page.headers.get('Content-Type')).toContain('text/html')
		expect(await page.text()).toContain(`agent-canvas open --session ${SESSION}`)
	})

	test('the link push opened sets the cookie once, and the UI routes then answer', async () => {
		const [link] = openedUrls()
		if (link === undefined) throw new Error('push opened no browser')
		expect(link.startsWith(`${base}/s/${SESSION}?code=`)).toBe(true)

		const bootstrap = await fetch(link, { redirect: 'manual' })
		expect(bootstrap.status).toBe(303)
		expect(bootstrap.headers.get('Location')).toBe(`/s/${SESSION}`)
		const setCookie = bootstrap.headers.get('Set-Cookie') ?? ''
		expect(setCookie).toContain('HttpOnly')
		expect(setCookie).toContain('SameSite=Strict')
		expect(setCookie).toContain('Path=/')
		const cookie = cookiePair(bootstrap)

		// The code is spent: the same link does not bootstrap a second browser.
		expect((await fetch(link, { redirect: 'manual' })).status).toBe(401)

		const headers = { Cookie: cookie }
		const file = `${base}/api/file?session=${SESSION}&path=${encodeURIComponent(join(project, 'notes.txt'))}`
		const read = await fetch(file, { headers })
		expect(read.status).toBe(200)
		expect(await read.text()).toContain('project notes')
		expect((await fetch(`${base}/api/sessions`, { headers })).status).toBe(200)
		expect(await upgradeStatus(`/ws/session/${SESSION}`, headers)).toBe(101)
		expect((await fetch(`${base}/s/${SESSION}`, { headers })).status).not.toBe(401)
		// A wrong cookie is no cookie.
		expect((await fetch(`${base}/api/sessions`, { headers: { Cookie: `${cookie.split('=')[0]}=forged` } })).status).toBe(401)
	})

	test('`open` prints and opens a fresh link', async () => {
		const before = openedUrls().length
		const result = await cli(['open', '--session', SESSION])
		expect(result.exitCode).toBe(0)
		const link = openedUrls()[before]
		if (link === undefined) throw new Error('open opened no browser')
		expect(result.stdout).toContain(link)
		const bootstrap = await fetch(link, { redirect: 'manual' })
		expect(bootstrap.status).toBe(303)
		expect((await fetch(`${base}/api/sessions`, { headers: { Cookie: cookiePair(bootstrap) } })).status).toBe(200)
	}, 30_000)

	test('the CLI keeps working on its own capability: push, watch, exec --secret', async () => {
		const link = (await cli(['open', '--session', SESSION, '--no-open'])).stdout.trim().split(/\s+/).find((word) => word.startsWith(base))
		if (link === undefined) throw new Error('open printed no link')
		const cookie = cookiePair(await fetch(link, { redirect: 'manual' }))

		const again = await cli(['push', canvases, '--label', 'Demo'])
		expect(again.exitCode).toBe(0)
		expect(JSON.parse(again.stdout).revision).toBe(2)

		const stored = await fetch(`${base}/api/session/${SESSION}/secrets/api-key/value`, {
			method: 'POST',
			headers: { Cookie: cookie, Origin: base, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' },
			body: JSON.stringify({ value: 'dummy-secret-value' }),
		})
		expect(stored.status).toBe(200)
		const exec = await cli([
			'exec',
			'--secret',
			'UI_CREDENTIAL_TEST=api-key',
			'--',
			process.execPath,
			'-e',
			"process.exit(process.env.UI_CREDENTIAL_TEST === 'dummy-secret-value' ? 0 : 3)",
		])
		expect(exec.exitCode).toBe(0)

		await submitFeedback('Looks good')
		const watched = await cli(['watch', '--session', SESSION])
		expect(watched.exitCode).toBe(0)
		expect(watched.stdout).toContain('Looks good')
	}, 60_000)

	test('the UI secret is kept in the data directory, readable by its owner only', () => {
		const file = join(home, '.claude', 'agent-canvas', 'ui-token')
		expect(statSync(file).mode & 0o777).toBe(0o600)
	})
})
