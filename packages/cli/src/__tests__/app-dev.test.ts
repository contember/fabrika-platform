// `fabrika app dev` on the template application: a picked caller reaches the API and the SPA through the kit, a
// browser that picked nobody is sent to the picker, and nothing but loopback is served. The served runs need
// FABRIKA_TEST_POSTGRES_URL, the tests' database, and skip cleanly without it. The URL is a credential: no assertion
// prints it, and the command's output is checked for it.

import { SQL, type Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAppDevArgs } from '../app-dev'

setDefaultTimeout(60_000)

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const CLI = join(import.meta.dir, '..', 'index.ts')
const TEMPLATE = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'zerops-app')

if (url === '') {
	console.warn('app-dev.test.ts skipped: set FABRIKA_TEST_POSTGRES_URL to run the Postgres-backed tests')
}

/** Runs `fabrika app dev` in `cwd` until it exits; answers its exit code and its whole output. */
async function exited(cwd: string, env: Readonly<Record<string, string>>, args: readonly string[] = ['--port=0']) {
	const child = Bun.spawn(['bun', CLI, 'app', 'dev', ...args], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: process.env['PATH'] ?? '', ...env },
	})
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
	return { code, output: `${stdout}${stderr}` }
}

describe('fabrika app dev refuses before it serves', () => {
	test('any host but loopback, and a port out of range', () => {
		expect(() => parseAppDevArgs(['--host=0.0.0.0'])).toThrow('app dev serves this machine only')
		expect(() => parseAppDevArgs(['--host=192.168.1.10'])).toThrow('not 192.168.1.10')
		expect(() => parseAppDevArgs(['--port=70000'])).toThrow('--port is 0 to 65535')
		expect(parseAppDevArgs([])).toEqual({ port: 3000, host: '127.0.0.1' })
		expect(parseAppDevArgs(['--port=0', '--host=::1'])).toEqual({ port: 0, host: '::1' })
	})

	test('a directory without a contract, as a process', async () => {
		const child = Bun.spawn(['bun', CLI, 'app', 'dev', '--port=0'], {
			cwd: import.meta.dir,
			stdout: 'pipe',
			stderr: 'pipe',
			env: { PATH: process.env['PATH'] ?? '' },
		})
		const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
		expect(code).toBe(1)
		expect(stderr).toContain('app dev: no fabrika.contract.ts')
	})

	test("an application's startup error is a fixed code: its message may carry a credential", async () => {
		const root = mkdtempSync(join(tmpdir(), 'fabrika-app-dev-'))
		try {
			writeFileSync(join(root, 'fabrika.contract.ts'), '')
			mkdirSync(join(root, 'src'))
			writeFileSync(join(root, 'src', 'app.ts'), "throw new Error(`cannot reach the mail API with ${process.env['MAIL_API_KEY']}`)\n")
			const failed = await exited(root, { MAIL_API_KEY: 'mail-key-9f3c', FABRIKA_TEST_POSTGRES_URL: 'postgres://u:pw-77ab@localhost/db' })
			expect(failed.code).toBe(1)
			expect(failed.output).toContain('app dev could not start: start_failed')
			expect(failed.output).not.toContain('mail-key-9f3c')
			expect(failed.output).not.toContain('pw-77ab')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test("its own refusal keeps its message: the template without the tests' database", async () => {
		const failed = await exited(TEMPLATE, {})
		expect(failed.code).toBe(1)
		expect(failed.output).toContain('app dev needs FABRIKA_TEST_POSTGRES_URL')
	})
})

/** The session-level advisory lock that holds a test schema, as `@fabrika/db/testing` derives it. */
const schemaLockKey = (schema: string): string =>
	String(createHash('sha256').update(`fabrika-test-schema:${schema}`, 'utf8').digest().readUIntBE(0, 6) + 1)

describe.skipIf(url === '')('fabrika app dev that cannot listen', () => {
	test('a port in use is named, and the throwaway schema it migrated is dropped before it exits', async () => {
		const held = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') })
		const sql = new SQL({ url, adapter: 'postgres', max: 1 })
		const schemas = async (): Promise<string[]> => {
			const rows: unknown = await sql.unsafe("SELECT nspname AS name FROM pg_namespace WHERE nspname LIKE 'app\\_test\\_%'")
			return Array.isArray(rows) ? rows.map((row: unknown) => String(typeof row === 'object' && row !== null ? Reflect.get(row, 'name') : '')) : []
		}
		try {
			const before = new Set(await schemas())
			const failed = await exited(TEMPLATE, { FABRIKA_TEST_POSTGRES_URL: url }, [`--port=${held.port}`])
			expect(failed.code).toBe(1)
			expect(failed.output).toContain(`app dev: port ${held.port} on 127.0.0.1 is in use`)
			expect(failed.output).not.toContain(url)
			// A schema another live run holds stays locked; one this run left behind would be free.
			const left: string[] = []
			for (const schema of (await schemas()).filter((name) => !before.has(name))) {
				const taken: unknown = await sql.unsafe('SELECT pg_try_advisory_lock($1::bigint) AS taken', [schemaLockKey(schema)])
				if (Array.isArray(taken) && Reflect.get(taken[0], 'taken') === true) {
					left.push(schema)
					await sql.unsafe('SELECT pg_advisory_unlock($1::bigint)', [schemaLockKey(schema)])
				}
			}
			expect(left).toEqual([])
		} finally {
			await sql.close()
			held.stop(true)
		}
	})
})

describe.skipIf(url === '')('fabrika app dev on the template application', () => {
	let child: Subprocess<'ignore', 'pipe', 'pipe'> | undefined
	let origin = ''
	let output = ''

	beforeAll(async () => {
		const spawned = Bun.spawn(['bun', CLI, 'app', 'dev', '--port=0'], {
			cwd: TEMPLATE,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { PATH: process.env['PATH'] ?? '', FABRIKA_TEST_POSTGRES_URL: url },
		})
		child = spawned
		const reader = spawned.stdout.getReader()
		while (!output.includes('\n')) {
			const { value, done } = await reader.read()
			if (done) throw new Error(`app dev exited: ${await new Response(spawned.stderr).text()}`)
			output += new TextDecoder().decode(value)
		}
		reader.releaseLock()
		origin = output.trim()
	})

	afterAll(async () => {
		child?.kill('SIGTERM')
		const code = await child?.exited
		const stderr = child === undefined ? '' : await new Response(child.stderr).text()
		expect(code).toBe(0)
		expect(`${output}${stderr}`).not.toContain(url)
	})

	const pick = async (role: string, scope: string): Promise<string> => {
		const chosen = await fetch(`${origin}__fabrika/dev/as?role=${role}&scope=${scope}&next=/`, { redirect: 'manual' })
		expect(chosen.status).toBe(303)
		expect(chosen.headers.get('Location')).toBe('/')
		return (chosen.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
	}

	test('it prints only its loopback address', () => {
		expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
	})

	test('the picker lists the roles; a browser that picked nobody is sent there from a page of the SPA', async () => {
		const picker = await fetch(`${origin}__fabrika/dev`)
		expect(picker.status).toBe(200)
		expect(await picker.text()).toContain('<option value="author">author (app-wide)</option>')
		const navigation = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' }
		const page = await fetch(origin, { redirect: 'manual', headers: navigation })
		expect(page.status).toBe(302)
		expect(page.headers.get('Location')).toBe('/__fabrika/dev?next=%2F')
		const call = await fetch(`${origin}api/notes.list`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		expect(call.status).toBe(401)
		expect(await call.json()).toMatchObject({ error: { loginUrl: '/__fabrika/dev?next=%2Fapi%2Fnotes.list' } })
	})

	test('a picked author gets 200 from the API and the SPA page; a role of another workspace reaches none of its notes', async () => {
		const author = await pick('author', '')
		const created = await fetch(`${origin}api/notes.create`, {
			method: 'POST',
			headers: { Cookie: author, 'Content-Type': 'application/json' },
			body: JSON.stringify({ workspaceId: 'w1', title: 'Clicked' }),
		})
		expect(created.status).toBe(200)
		const listed = await fetch(`${origin}api/notes.list`, {
			method: 'POST',
			headers: { Cookie: author, 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(listed.status).toBe(200)
		expect(JSON.stringify(await listed.json())).toContain('Clicked')
		const page = await fetch(origin, { headers: { Cookie: author } })
		expect(page.status).toBe(200)
		expect(page.headers.get('Content-Type')).toContain('text/html')
	})

	test('a membership role needs its scope value, and an app-wide one takes none', async () => {
		expect((await fetch(`${origin}__fabrika/dev/as?role=guest&scope=`, { redirect: 'manual' })).status).toBe(400)
		expect((await fetch(`${origin}__fabrika/dev/as?role=author&scope=w1`, { redirect: 'manual' })).status).toBe(400)
		expect((await fetch(`${origin}__fabrika/dev/as?role=nobody&scope=`, { redirect: 'manual' })).status).toBe(400)
		const guest = await pick('guest', 'w2')
		const listed = await fetch(`${origin}api/notes.list`, {
			method: 'POST',
			headers: { Cookie: guest, 'Content-Type': 'application/json' },
			body: '{}',
		})
		expect(listed.status).toBe(200)
		expect(JSON.stringify(await listed.json())).not.toContain('Clicked')
	})
})
