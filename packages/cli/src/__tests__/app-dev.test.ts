// `fabrika app dev` on the template application and on `fixtures/dev-app/`, each with its `dev/seed.ts`: the seed's
// personas are on the picker and choosing one is that caller on the API and the SPA, a link the seed issued opens as
// its holder, every SPA page carries the dev toolbar (and a kit's own responses never do), the toolbar's switch and the
// mail view change the caller, and nothing but loopback is served. The served runs need FABRIKA_TEST_POSTGRES_URL, the
// tests' database, and skip cleanly without it. The URL is a credential: no assertion prints it, and the command's
// output is checked for it, for a link key and for a mailbox.

import { testKit } from '@fabrika/app/testing'
import { testDatabase } from '@fabrika/db/testing'
import { SQL, type Subprocess } from 'bun'
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { parseAppDevArgs } from '../app-dev'
import { devOutbox, readDevEnv } from '../app-dev-outside'

setDefaultTimeout(60_000)

const url = process.env['FABRIKA_TEST_POSTGRES_URL'] ?? ''
const CLI = join(import.meta.dir, '..', 'index.ts')
const TEMPLATE = join(import.meta.dir, '..', '..', '..', '..', 'examples', 'zerops-app')
const DEV_APP = join(import.meta.dir, 'fixtures', 'dev-app')
const DEV_OUTSIDE = join(import.meta.dir, 'fixtures', 'dev-outside')
const TOOLBAR_TAG = '<script src="/__fabrika/dev/toolbar.js" defer></script>'

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

/** `fabrika app dev` serving `cwd` until `stop`, which answers its exit code and whole output. */
async function served(cwd: string): Promise<{ readonly origin: string; stop(): Promise<{ readonly code: number; readonly output: string }> }> {
	const child: Subprocess<'ignore', 'pipe', 'pipe'> = Bun.spawn(['bun', CLI, 'app', 'dev', '--port=0'], {
		cwd,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		env: { PATH: process.env['PATH'] ?? '', FABRIKA_TEST_POSTGRES_URL: url },
	})
	let stdout = ''
	const reader = child.stdout.getReader()
	while (!stdout.includes('\n')) {
		const { value, done } = await reader.read()
		if (done) throw new Error(`app dev exited: ${await new Response(child.stderr).text()}`)
		stdout += new TextDecoder().decode(value)
	}
	const origin = stdout.trim()
	return {
		origin,
		async stop() {
			child.kill('SIGTERM')
			const code = await child.exited
			for (let read = await reader.read(); !read.done; read = await reader.read()) stdout += new TextDecoder().decode(read.value)
			return { code, output: `${stdout}${await new Response(child.stderr).text()}` }
		},
	}
}

const json = (body: unknown, cookie?: string): RequestInit => ({
	method: 'POST',
	headers: { 'Content-Type': 'application/json', ...(cookie === undefined ? {} : { Cookie: cookie }) },
	body: JSON.stringify(body),
})

/** The cookie a choice of the picker or the toolbar sets, after checking it goes on to `next`. */
async function chosen(href: string, next: string): Promise<string> {
	const response = await fetch(href, { redirect: 'manual' })
	expect(response.status).toBe(303)
	expect(response.headers.get('Location')).toBe(next)
	return (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? ''
}

const ToolbarState = z.object({
	current: z.object({ name: z.string(), detail: z.string() }),
	personas: z.array(z.object({ name: z.string(), detail: z.string(), href: z.string(), current: z.boolean() })),
	links: z.array(z.object({ title: z.string(), detail: z.string(), href: z.string() })),
	mail: z.array(z.object({ subject: z.string(), detail: z.string(), action: z.object({ label: z.string(), href: z.string() }).nullable() })),
	picker: z.string(),
})

async function stateOf(origin: string, cookie: string | null, next = '/') {
	const response = await fetch(`${origin}__fabrika/dev/state?next=${encodeURIComponent(next)}`, cookie === null ? {} : { headers: { Cookie: cookie } })
	expect(response.status).toBe(200)
	return ToolbarState.parse(await response.json())
}

const PageCaller = z.object({ email: z.string() })

describe('fabrika app dev refuses before it serves', () => {
	test('any host but loopback, a port out of range, and a seed flag without a module', () => {
		expect(() => parseAppDevArgs(['--host=0.0.0.0'])).toThrow('app dev serves this machine only')
		expect(() => parseAppDevArgs(['--host=192.168.1.10'])).toThrow('not 192.168.1.10')
		expect(() => parseAppDevArgs(['--port=70000'])).toThrow('--port is 0 to 65535')
		expect(() => parseAppDevArgs(['--seed'])).toThrow('--seed names a module')
		expect(parseAppDevArgs([])).toEqual({ port: 3000, host: '127.0.0.1', seed: null })
		expect(parseAppDevArgs(['--port=0', '--host=::1', '--seed', 'dev/other.ts'])).toEqual({ port: 0, host: '::1', seed: 'dev/other.ts' })
		expect(parseAppDevArgs(['--seed=dev/other.ts']).seed).toBe('dev/other.ts')
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

	test("its own refusal keeps its message: the template without the tests' database, a --seed naming no file", async () => {
		const failed = await exited(TEMPLATE, {})
		expect(failed.code).toBe(1)
		expect(failed.output).toContain('app dev needs FABRIKA_TEST_POSTGRES_URL')
		const unseeded = await exited(TEMPLATE, {}, ['--port=0', '--seed=dev/missing.ts'])
		expect(unseeded.code).toBe(1)
		expect(unseeded.output).toContain('app dev: --seed names no file: dev/missing.ts')
	})
})

describe("app dev's stand-ins for the outside, without serving", () => {
	test('dev/dev.env: NAME=value lines, comments and quotes; a malformed line or a framework name is refused by its line', () => {
		const root = mkdtempSync(join(tmpdir(), 'fabrika-app-dev-env-'))
		try {
			expect(readDevEnv(root)).toEqual({})
			mkdirSync(join(root, 'dev'))
			writeFileSync(join(root, 'dev', 'dev.env'), '# comment\n\nPLAIN=one\nQUOTED="two words"\nSINGLE=\'3\'\nEMPTY=\n')
			expect(readDevEnv(root)).toEqual({ PLAIN: 'one', QUOTED: 'two words', SINGLE: '3', EMPTY: '' })
			writeFileSync(join(root, 'dev', 'dev.env'), 'OK=1\nno equals sign here\n')
			expect(() => readDevEnv(root)).toThrow('app dev: dev/dev.env line 2 is no NAME=value')
			writeFileSync(join(root, 'dev', 'dev.env'), 'FABRIKA_IAM_ISSUER=secret-value-9\n')
			expect(() => readDevEnv(root)).toThrow('line 1 sets FABRIKA_IAM_ISSUER, a framework variable')
			expect(() => readDevEnv(root)).not.toThrow('secret-value-9')
		} finally {
			rmSync(root, { recursive: true, force: true })
		}
	})

	test('the dev outbox captures a request to its origin, body only, passes every other on, and restores fetch', async () => {
		const original = globalThis.fetch
		const outbox = devOutbox()
		const restore = outbox.install()
		try {
			const answer = await fetch('https://outbox.invalid/mail', {
				method: 'POST',
				headers: { Authorization: 'Bearer key-31', 'Content-Type': 'application/json' },
				body: JSON.stringify({ to: 'a@example.test', subject: 'Hi' }),
			})
			expect(answer.status).toBe(200)
			expect(outbox.outbox()).toEqual([
				{ id: 1, method: 'POST', path: '/mail', contentType: 'application/json', body: '{"to":"a@example.test","subject":"Hi"}' },
			])
			expect(JSON.stringify(outbox.outbox())).not.toContain('key-31')
			await expect(fetch('http://127.0.0.1:1/unreachable')).rejects.toThrow()
		} finally {
			restore()
		}
		expect(globalThis.fetch).toBe(original)
	})
})

/** The session-level advisory lock that holds a test schema, as `@fabrika/db/testing` derives it. */
const schemaLockKey = (schema: string): string =>
	String(createHash('sha256').update(`fabrika-test-schema:${schema}`, 'utf8').digest().readUIntBE(0, 6) + 1)

describe.skipIf(url === '')('fabrika app dev that cannot start', () => {
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

	test("a seed that throws is printed whole, stack included, and one whose answer is wrong is named by the entry's position", async () => {
		const dir = mkdtempSync(join(tmpdir(), 'fabrika-app-dev-seed-'))
		try {
			writeFileSync(join(dir, 'throws.ts'), "export default async () => { throw new Error(`seeding with ${process.env['SEED_TOKEN']}`) }\n")
			writeFileSync(
				join(dir, 'stranger.ts'),
				"export default () => ({ personas: [{ name: 'Mallory', caller: { kind: 'human', email: 'm@x.test' } }] })\n",
			)
			const thrown = await exited(TEMPLATE, { FABRIKA_TEST_POSTGRES_URL: url, SEED_TOKEN: 'seed-secret-41aa' }, [
				'--port=0',
				`--seed=${join(dir, 'throws.ts')}`,
			])
			expect(thrown.code).toBe(1)
			expect(thrown.output).toContain('app dev could not seed: the seed threw')
			// The developer's own code on the developer's machine: its message and where it threw.
			expect(thrown.output).toContain('seeding with seed-secret-41aa')
			expect(thrown.output).toContain('throws.ts:1')
			expect(thrown.output).not.toContain(url)
			const stranger = await exited(TEMPLATE, { FABRIKA_TEST_POSTGRES_URL: url }, ['--port=0', `--seed=${join(dir, 'stranger.ts')}`])
			expect(stranger.code).toBe(1)
			expect(stranger.output).toContain('app dev: persona 1 of the seed holds no person of its kit')
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})

describe.skipIf(url === '')('fabrika app dev on the template application, seeded by its dev/seed.ts', () => {
	let origin = ''
	let stop: () => Promise<{ readonly code: number; readonly output: string }> = () => Promise.resolve({ code: 0, output: '' })

	beforeAll(async () => {
		const server = await served(TEMPLATE)
		origin = server.origin
		stop = server.stop
	})

	afterAll(async () => {
		const { code, output } = await stop()
		expect(code).toBe(0)
		expect(output).toContain('seeded personas: 3, link pages: 0')
		for (const secret of [url, 'px_', '@notes.example', '@studio.example']) expect(output).not.toContain(secret)
	})

	const meOf = async (cookie: string) => {
		const response = await fetch(`${origin}__fabrika-me.json`, { headers: { Cookie: cookie } })
		expect(response.status).toBe(200)
		return PageCaller.parse(await response.json()).email
	}
	const titlesOf = async (cookie: string): Promise<string> => {
		const listed = await fetch(`${origin}api/notes.list`, json({}, cookie))
		expect(listed.status).toBe(200)
		return JSON.stringify(await listed.json())
	}

	test('it prints only its loopback address, and answers no request addressed to another host', async () => {
		expect(origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
		const rebound = await fetch(`${origin}__fabrika/dev/state`, { headers: { Host: `attacker.example:${new URL(origin).port}` } })
		expect(rebound.status).toBe(421)
		expect((await fetch(`${origin}__fabrika/dev`, { headers: { Host: `localhost:${new URL(origin).port}` } })).status).toBe(200)
	})

	test("the picker shows the seed's personas first, in the vocabulary's language, then another role, then anonymous", async () => {
		const picker = await fetch(`${origin}__fabrika/dev`)
		expect(picker.status).toBe(200)
		expect(picker.headers.get('Content-Security-Policy')).toStartWith("default-src 'none';")
		const page = await picker.text()
		expect(page).toContain('<html lang="cs">')
		const at = (text: string) => {
			const index = page.indexOf(text)
			expect(index).toBeGreaterThan(-1)
			return index
		}
		expect(at('>Petra<')).toBeLessThan(at('>Tomáš<'))
		expect(at('>Tomáš<')).toBeLessThan(at('>Gita<'))
		expect(at('>Gita<')).toBeLessThan(at('>Jiná role<'))
		expect(at('>Jiná role<')).toBeLessThan(at('>Pokračovat anonymně<'))
		expect(page).toContain('gita@partner.example')
		expect(page).toContain('<span class="badge external">externí</span>')
		expect(page).toContain('<span class="badge role">guest · Design</span>')
		expect(page).toContain('<option value="design">Design</option>')
		expect(page).not.toContain('<script')
	})

	test('a browser that picked nobody is sent to the picker from a page of the SPA, and an API call gets its loginUrl', async () => {
		const navigation = { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'none' }
		const page = await fetch(origin, { redirect: 'manual', headers: navigation })
		expect(page.status).toBe(302)
		expect(page.headers.get('Location')).toBe('/__fabrika/dev?next=%2F')
		const call = await fetch(`${origin}api/notes.list`, json({}))
		expect(call.status).toBe(401)
		expect(await call.json()).toMatchObject({ error: { loginUrl: '/__fabrika/dev?next=%2Fapi%2Fnotes.list' } })
	})

	test("a persona chosen on the picker is that caller: a 200 from the API with the seed's notes, and the SPA page", async () => {
		const tomas = await chosen(`${origin}__fabrika/dev/as?persona=${encodeURIComponent('Tomáš')}&next=/`, '/')
		expect(await titlesOf(tomas)).toContain('Brand refresh brief')
		expect(await titlesOf(tomas)).not.toContain('Q4 pipeline')
		expect(await meOf(tomas)).toBe('tomas@notes.example')
		const page = await fetch(origin, { headers: { Cookie: tomas } })
		expect(page.status).toBe(200)
		expect(page.headers.get('Content-Type')).toContain('text/html')
	})

	test('an unknown persona is refused, and a membership role needs its scope value while an app-wide one takes none', async () => {
		expect((await fetch(`${origin}__fabrika/dev/as?persona=Mallory`, { redirect: 'manual' })).status).toBe(400)
		expect((await fetch(`${origin}__fabrika/dev/as?role=guest&scope=`, { redirect: 'manual' })).status).toBe(400)
		expect((await fetch(`${origin}__fabrika/dev/as?role=author&scope=w1`, { redirect: 'manual' })).status).toBe(400)
		expect((await fetch(`${origin}__fabrika/dev/as?role=nobody&scope=`, { redirect: 'manual' })).status).toBe(400)
		const guest = await chosen(`${origin}__fabrika/dev/as?role=guest&scope=w2&next=/`, '/')
		expect(await titlesOf(guest)).not.toContain('Brand refresh brief')
		const author = await chosen(`${origin}__fabrika/dev/as?role=author&next=/`, '/')
		expect((await fetch(`${origin}api/notes.create`, json({ workspaceId: 'w1', title: 'Clicked' }, author))).status).toBe(200)
		expect(await titlesOf(author)).toContain('Clicked')
	})

	test("every SPA page carries the toolbar's same-origin script, which the page's own policy admits as it is", async () => {
		const petra = await chosen(`${origin}__fabrika/dev/as?persona=Petra&next=/`, '/')
		const page = await fetch(`${origin}some/deep/route`, { headers: { Cookie: petra } })
		expect(page.status).toBe(200)
		const html = await page.text()
		expect(html.split(TOOLBAR_TAG).length).toBe(2)
		const scriptSrc = (page.headers.get('Content-Security-Policy') ?? '').split(';').map((directive) => directive.trim()).find((directive) =>
			directive.startsWith('script-src ')
		)
		expect(scriptSrc).toBe("script-src 'self'")
		const script = await fetch(`${origin}__fabrika/dev/toolbar.js`)
		expect(script.status).toBe(200)
		expect(script.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
		expect(await script.text()).toContain('attachShadow')
		expect((await fetch(`${origin}api/notes.list`, json({}, petra))).headers.get('Content-Type')).toContain('application/json')
	})

	test("switching the persona with the toolbar's link changes the caller and goes back to the page", async () => {
		const petra = await chosen(`${origin}__fabrika/dev/as?persona=Petra&next=/`, '/')
		const state = await stateOf(origin, petra, '/notes?view=all')
		expect(state.current).toEqual({ name: 'Petra', detail: 'staff, editor · Design, editor · Sales' })
		expect(state.personas.map((persona) => [persona.name, persona.current])).toEqual([['Petra', true], ['Tomáš', false], ['Gita', false]])
		expect(await titlesOf(petra)).toContain('Q4 pipeline')
		const gita = state.personas.find((persona) => persona.name === 'Gita')
		if (gita === undefined) throw new Error('the toolbar lists no Gita')
		expect(gita.detail).toBe('guest · Design, externí')
		const switched = await chosen(new URL(gita.href, origin).href, '/notes?view=all')
		expect(await meOf(switched)).toBe('gita@partner.example')
		expect(await titlesOf(switched)).toContain('Logo options')
		expect(await titlesOf(switched)).not.toContain('Q4 pipeline')
	})

	test('the mail view lists the invitation the seed sent; its link accepts it, as the invited person from then on', async () => {
		const before = await stateOf(origin, null)
		expect(before.mail).toHaveLength(1)
		const [invitation] = before.mail
		expect(invitation?.subject).toBe('Pozvánka: guest v Design')
		expect(invitation?.detail).toBe('Komu: marta@studio.example · čeká')
		const accept = invitation?.action?.href ?? ''
		expect(accept).toStartWith('/__fabrika/dev/accept?invitation=')
		const marta = await chosen(new URL(accept, origin).href, '/')
		expect(await meOf(marta)).toBe('marta@studio.example')
		expect(await titlesOf(marta)).toContain('Interview notes, week 41')
		const after = await stateOf(origin, marta)
		expect(after.current.name).toBe('marta@studio.example')
		expect(after.mail[0]?.detail).toBe('Komu: marta@studio.example · přijata')
		expect(after.mail[0]?.action?.label).toBe('Pokračovat jako tato osoba')
		const again = await fetch(new URL(accept, origin), { redirect: 'manual' })
		expect(again.status).toBe(409)
	})
})

describe.skipIf(url === '')('fabrika app dev on an application with a share link and a built SPA', () => {
	let origin = ''
	let stop: () => Promise<{ readonly code: number; readonly output: string }> = () => Promise.resolve({ code: 0, output: '' })

	beforeAll(async () => {
		const server = await served(DEV_APP)
		origin = server.origin
		stop = server.stop
	})

	afterAll(async () => {
		const { code, output } = await stop()
		expect(code).toBe(0)
		expect(output).toContain('seeded personas: 1, link pages: 1')
		for (const secret of [url, 'px_', '@cards.example']) expect(output).not.toContain(secret)
	})

	test("the picker is in English under the application's display name, with the seed's link page", async () => {
		const page = await (await fetch(`${origin}__fabrika/dev`)).text()
		expect(page).toContain('<html lang="en">')
		expect(page).toContain('<title>Cards · Development preview</title>')
		expect(page).toContain('>The shared card<')
		expect(page).toContain('>Open as link holder →<')
	})

	test('a link the seed issued opens as its holder: the share page, and its procedure with the key the link carries', async () => {
		const [link] = (await stateOf(origin, null)).links
		expect(link?.title).toBe('The shared card')
		const href = link?.href ?? ''
		expect(href).toMatch(/^\/s\/#px_link_[0-9a-f]+$/)
		const key = href.slice('/s/#'.length)
		const page = await fetch(`${origin}s/`)
		expect(page.status).toBe(200)
		expect(await page.text()).toContain(TOOLBAR_TAG)
		const read = await fetch(`${origin}s/api/card`, { ...json({}), headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` } })
		expect(read.status).toBe(200)
		expect(await read.json()).toMatchObject({ result: { title: 'Ship the preview' } })
		const forged = await fetch(`${origin}s/api/card`, {
			...json({}),
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer px_link_0' },
		})
		expect(forged.status).toBe(401)
	})

	test("the built SPA page has the toolbar before its </body> under app dev, and none from the kit's own browser", async () => {
		const lena = await chosen(`${origin}__fabrika/dev/as?persona=Lena&next=/`, '/')
		const page = await (await fetch(origin, { headers: { Cookie: lena } })).text()
		expect(page).toContain(`${TOOLBAR_TAG}</body>`)

		const postgres = await testDatabase({ migrations: join(DEV_APP, 'db', 'migrations'), label: 'app-dev.test.ts' })
		try {
			if (postgres === null) throw new Error('the served run had its database, so this one has it too')
			const { default: app } = await import('./fixtures/dev-app/src/app')
			const kit = testKit(app, { root: DEV_APP, database: postgres.database })
			const lead = kit.testCaller([{ role: 'lead' }])
			const fromKit = await kit.browser(lead)('/')
			expect(fromKit.status).toBe(200)
			const html = await fromKit.text()
			expect(html).toContain('<h1>Cards</h1>')
			expect(html).not.toContain('/__fabrika/dev/')
			expect(await (await kit.browser(lead)('/__fabrika/dev/toolbar.js')).text()).not.toContain('attachShadow')
		} finally {
			await postgres?.close()
		}
	})
})

describe.skipIf(url === '')("fabrika app dev's stand-ins for the outside: a form's challenge, the dev outbox, dev/dev.env", () => {
	let origin = ''
	let stop: () => Promise<{ readonly code: number; readonly output: string }> = () => Promise.resolve({ code: 0, output: '' })

	beforeAll(async () => {
		// The shell sets no application variable: the challenge secret and the mail provider come from dev/dev.env.
		const server = await served(DEV_OUTSIDE)
		origin = server.origin
		stop = server.stop
	})

	afterAll(async () => {
		const { code, output } = await stop()
		expect(code).toBe(0)
		// The seed ran the job that throws: its message and stack are printed, on the developer's machine.
		expect(output).toContain("fabrika app dev: job 'broken' attempt 1 threw")
		expect(output).toContain('the broken job threw on purpose')
		for (const secret of [url, 'dev-turnstile-secret', 'dev-mail-key']) expect(output).not.toContain(secret)
	})

	test("the seed's sign-up passed the challenge, and the mail the job sent is in the mail view with its body", async () => {
		const { mail } = await stateOf(origin, null)
		expect(mail).toHaveLength(1)
		const [sent] = mail
		expect(sent?.subject).toBe('Welcome aboard')
		expect(sent?.detail).toBe('To: ada@signup.example · sent')
		expect(sent?.action?.label).toBe('Open the message')
		const opened = await fetch(new URL(sent?.action?.href ?? '', origin))
		expect(opened.status).toBe(200)
		expect(opened.headers.get('X-Content-Type-Options')).toBe('nosniff')
		const body = await opened.text()
		expect(body).toStartWith('POST https://outbox.invalid/mail')
		expect(body).toContain('Hello ada@signup.example, your sign-up is in.')
		expect(body).not.toContain('dev-mail-key')
		expect((await fetch(`${origin}__fabrika/dev/outbox/99`)).status).toBe(404)
	})
})
