import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILDER_CLI_TOKEN_HEADER, BUILDER_DAEMON_HOST } from '../../shared'

/**
 * The commands that open the dashboard ask the daemon for a sign-in link with the CLI capability and hand the browser a
 * file only the user reads, never the link: other OS users read every process's arguments.
 */

const BIN = resolve(import.meta.dir, '../src/bin.ts')
const CAPABILITY = 'dummy-cli-capability'
const root = mkdtempSync(join(tmpdir(), 'fabrika-dashboard-link-'))
const project = join(root, 'project')
const temp = join(root, 'tmp')
const fakeBin = join(root, 'bin')
const opened = join(root, 'opener-arguments')
const dataDir = join(root, 'data')
let server: ReturnType<typeof Bun.serve> | undefined
let link = ''
let pushIsNew = true
/** Whether the push answers as this release's daemon does, with a sign-in link for a new session. */
let pushSignsIn = true
const linkRequests: (string | null)[] = []

beforeAll(() => {
	for (const dir of [project, fakeBin, dataDir]) mkdirSync(dir, { recursive: true })
	mkdirSync(join(temp, 'fabrika'), { recursive: true, mode: 0o700 })
	writeFileSync(join(temp, 'fabrika', 'daemon-auth-token'), CAPABILITY, { mode: 0o600 })
	for (const opener of ['xdg-open', 'open']) {
		writeFileSync(join(fakeBin, opener), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${opened}'\n`)
		chmodSync(join(fakeBin, opener), 0o755)
	}
	writeFileSync(join(project, 'view.jsx'), '<Section title="Plan">body</Section>')
	server = Bun.serve({
		port: 0,
		hostname: BUILDER_DAEMON_HOST,
		async fetch(request) {
			const url = new URL(request.url)
			link = `${url.origin}/open?code=dummy-sign-in-code`
			if (url.pathname === '/health') return Response.json({ ok: true, pid: process.pid, sessionsDir: join(dataDir, 'sessions') })
			if (url.pathname.endsWith('/link')) {
				linkRequests.push(request.headers.get(BUILDER_CLI_TOKEN_HEADER))
				return Response.json({ signInUrl: link })
			}
			if (url.pathname.endsWith('/plan')) {
				const page = `${url.origin}/s/dashboard-session`
				return Response.json({
					ok: true,
					browserUrl: page,
					...(pushIsNew && pushSignsIn ? { signInUrl: link } : {}),
					isNew: pushIsNew,
					revision: 1,
					canvasFiles: ['view.jsx'],
				})
			}
			return Response.json({ error: 'Not found' }, { status: 404 })
		},
	})
})

beforeEach(() => {
	rmSync(opened, { force: true })
	linkRequests.length = 0
	pushIsNew = true
	pushSignsIn = true
})

afterAll(() => {
	server?.stop(true)
	rmSync(root, { recursive: true, force: true })
})

async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, BIN, ...args], {
		cwd: project,
		env: {
			...process.env,
			HOME: root,
			TMPDIR: temp,
			FABRIKA_PORT: String(server?.port),
			FABRIKA_DATA_DIR: dataDir,
			FABRIKA_SESSION_ID: 'dashboard-session',
			PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
		},
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { code, stdout, stderr }
}

/** Every argument list the opener got, one per call. */
function openerCalls(): string[] {
	return existsSync(opened) ? readFileSync(opened, 'utf-8').split('\n').filter((line) => line !== '') : []
}

/** The link an opener call leads to: the call names a file of the user's own, which refreshes to it. */
function linkOf(call: string): string {
	expect(call).not.toContain('code=')
	expect(call.startsWith('file://')).toBe(true)
	const file = fileURLToPath(call)
	expect(statSync(file).mode & 0o777).toBe(0o600)
	const refresh = readFileSync(file, 'utf-8').match(/content="0;url=([^"]+)"/)?.[1]
	if (refresh === undefined) throw new Error('The opened file leads nowhere')
	return refresh.replaceAll('&amp;', '&')
}

test('`dashboard` asks for a link with the CLI capability, prints it, and opens it through a private file', async () => {
	const result = await run(['dashboard'])
	expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' })
	expect(JSON.parse(result.stdout)).toEqual({ ok: true, sessionId: 'dashboard-session', browserUrl: link })
	expect(linkRequests).toEqual([CAPABILITY])
	const calls = openerCalls()
	expect(calls).toHaveLength(1)
	expect(linkOf(calls[0] ?? '')).toBe(link)
	expect(statSync(join(temp, 'fabrika')).mode & 0o777).toBe(0o700)
})

test('`dashboard --no-open` prints the link and opens nothing', async () => {
	const result = await run(['dashboard', '--no-open'])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).browserUrl).toBe(link)
	expect(openerCalls()).toEqual([])
})

test('`gate open` opens the link its push answered with through a private file', async () => {
	const result = await run(['gate', 'open', 'vision', '--view', join(project, 'view.jsx')])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).browserUrl).toBe(link)
	const calls = openerCalls()
	expect(calls).toHaveLength(1)
	expect(linkOf(calls[0] ?? '')).toBe(link)
})

test('`gate open` on a session that exists prints the page and opens nothing', async () => {
	pushIsNew = false
	const result = await run(['gate', 'open', 'vision', '--view', join(project, 'view.jsx')])
	expect(result.code).toBe(0)
	expect(JSON.parse(result.stdout).browserUrl).toBe(`http://${BUILDER_DAEMON_HOST}:${server?.port}/s/dashboard-session`)
	expect(openerCalls()).toEqual([])
})

test('`gate open` against a daemon of an earlier release opens the page it answers with', async () => {
	pushSignsIn = false
	const result = await run(['gate', 'open', 'vision', '--view', join(project, 'view.jsx')])
	expect(result.code).toBe(0)
	const page = `http://${BUILDER_DAEMON_HOST}:${server?.port}/s/dashboard-session`
	expect(JSON.parse(result.stdout).browserUrl).toBe(page)
	expect(openerCalls()).toEqual([page])
})
