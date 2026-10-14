// `fabrika app dev`: a contract application served through its test kit on a loopback port, to click through its
// screens. The kit is the whole server: production's proxy decision, the stand-in IAM, the real `boot`, the SPAs from
// their build directories; Postgres is a throwaway schema of the tests' database. A caller picker chooses who the
// browser is; a cookie keeps the choice, and the kit's own session never leaves the process.

import { CONTRACT_FILE, IMPLEMENTATION_FILE } from '@fabrika/app/build'
import { implementationAt } from '@fabrika/app/bun'
import type { AnyContract } from '@fabrika/app/contract'
import type { ContractImplementation } from '@fabrika/app/implement'
import { type LabelledTestCaller, testKit } from '@fabrika/app/testing'
import { TEST_POSTGRES_URL, type TestDatabase, testDatabase } from '@fabrika/db/testing'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

export const APP_DEV_USAGE = `fabrika app dev — the application on a local port, to click through its screens

Usage:
  fabrika app dev [--port=<n>] [--host=<loopback address>]

Run from the application root. It serves ${IMPLEMENTATION_FILE} through its test kit: the production proxy decision,
the kit's stand-in IAM, each SPA from its built directory (run the SPA build first; an unbuilt one is an empty page),
and a throwaway schema of the database in ${TEST_POSTGRES_URL}, migrated from db/migrations/ and dropped on exit.
Pick who the browser is at /__fabrika/dev: a role of the vocabulary and, for a membership role, the scope value it is
held in. The application's own variables come from the environment. It listens on 127.0.0.1 (or ::1, localhost) only,
port 3000 unless --port says otherwise (0 picks a free one), and prints the address it serves.
`

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost'])
const PICKER_PATH = '/__fabrika/dev'
const CHOOSE_PATH = '/__fabrika/dev/as'
const CHOICE_COOKIE = 'fabrika-dev-as'
const MAX_SCOPE_VALUE = 200

export interface AppDevOptions {
	/** The application root. */
	readonly root: string
	readonly port: number
	readonly host: string
	/** The environment: the test database URL, and the application's own variables. */
	readonly env: Readonly<Record<string, string | undefined>>
}

export interface AppDevServer {
	/** The address it serves, `http://<host>:<port>/`. */
	readonly url: string
	/** Stops serving and drops the throwaway schema. */
	stop(): Promise<void>
}

/** Who the browser is: a role, and the scope value a membership role is held in. */
const Choice = z.strictObject({ role: z.string().min(1), value: z.string().min(1).max(MAX_SCOPE_VALUE).nullable() })
type Choice = z.infer<typeof Choice>

/** The proxy's sign-in answer to a fetch, whose `loginUrl` names the kit's IAM. */
const LoginRequired = z.object({ error: z.looseObject({ loginUrl: z.string() }) })

export function parseAppDevArgs(argv: readonly string[]): { readonly port: number; readonly host: string } {
	let port = 3000
	let host = '127.0.0.1'
	for (const arg of argv) {
		if (arg.startsWith('--port=')) {
			const parsed = Number(arg.slice('--port='.length))
			if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`app dev: --port is 0 to 65535, not ${arg.slice(7)}`)
			port = parsed
		} else if (arg.startsWith('--host=')) {
			host = arg.slice('--host='.length)
		} else {
			throw new Error(`app dev takes no argument ${arg}\n\n${APP_DEV_USAGE}`)
		}
	}
	if (!LOOPBACK.has(host)) {
		throw new Error(`app dev serves this machine only: --host is 127.0.0.1, ::1 or localhost, not ${host}`)
	}
	return { port, host }
}

/** The application's own variables: the environment without the framework's and the tests' `FABRIKA_*` names. */
function applicationVariables(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(env).flatMap(([name, value]) => (name.startsWith('FABRIKA_') || value === undefined ? [] : [[name, value]])),
	)
}

function cookieOf(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
		const [key, ...value] = part.trim().split('=')
		if (key === name) return value.join('=')
	}
	return undefined
}

/** The request's cookies without the picker's own, which the application never sees. */
function withoutChoice(cookies: string | null): string | null {
	if (cookies === null) return null
	const kept = cookies.split(';').map((part) => part.trim()).filter((part) => part !== '' && !part.startsWith(`${CHOICE_COOKIE}=`))
	return kept.length === 0 ? null : kept.join('; ')
}

/** A path of this origin to go on to; anything else is the root. */
function localPath(next: string | null): string {
	return next !== null && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
}

const escapeHtml = (text: string): string =>
	text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')

function pickerPage(contract: AnyContract, current: Choice | null, next: string): Response {
	const { roles, dimensions } = contract.vocabulary
	const options = Object.entries(roles).map(([name, role]) => {
		const scope = role.member === undefined ? 'app-wide' : `in one ${role.member.scope}`
		const selected = current?.role === name ? ' selected' : ''
		return `<option value="${escapeHtml(name)}"${selected}>${escapeHtml(name)} (${escapeHtml(scope)})</option>`
	})
	const body = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>fabrika app dev</title></head>
<body>
<h1>${escapeHtml(contract.vocabulary.app)}: who is the browser?</h1>
<p>${current === null ? 'Nobody yet.' : `Now: ${escapeHtml(current.role)}${current.value === null ? '' : ` in ${escapeHtml(current.value)}`}.`}</p>
<form method="get" action="${CHOOSE_PATH}">
<label>Role <select name="role">${options.join('')}</select></label>
<label>Scope value <input name="scope" maxlength="${MAX_SCOPE_VALUE}" placeholder="for a membership role"></label>
<input type="hidden" name="next" value="${escapeHtml(next)}">
<button type="submit">Use</button>
</form>
<p>Dimensions: ${Object.keys(dimensions).map(escapeHtml).join(', ')}. Clear the cookie ${CHOICE_COOKIE} to be nobody.</p>
</body>
</html>
`
	return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

/** Serves `app` through its test kit on a loopback port until `stop`. */
export async function startAppDev(app: ContractImplementation<AnyContract>, options: AppDevOptions): Promise<AppDevServer> {
	if (!LOOPBACK.has(options.host)) throw new Error(`app dev serves this machine only, not ${options.host}`)
	const contract = app.contract
	let postgres: TestDatabase | null = null
	if (app.database !== null) {
		if ((options.env[TEST_POSTGRES_URL] ?? '') === '') {
			throw new Error(`app dev needs ${TEST_POSTGRES_URL}, the database the tests use: it migrates a throwaway schema there`)
		}
		postgres = await testDatabase({ migrations: join(options.root, 'db', 'migrations'), label: 'fabrika app dev' })
	}
	const hasFiles = Object.keys(contract.surface.files ?? {}).length > 0
	const kit = testKit(app, {
		root: options.root,
		env: applicationVariables(options.env),
		...(postgres === null ? {} : { database: postgres.database }),
		...(hasFiles ? { files: new MemoryFileObjects() } : {}),
	})
	const callers = new Map<string, LabelledTestCaller>()

	/** The caller a choice names, made once and kept, so its membership changes last; `null` when the choice is no grant. */
	const callerOf = (choice: Choice): LabelledTestCaller | null => {
		const role = Object.hasOwn(contract.vocabulary.roles, choice.role) ? contract.vocabulary.roles[choice.role] : undefined
		if (role === undefined || (role.member !== undefined) !== (choice.value !== null)) return null
		const key = JSON.stringify(choice)
		const known = callers.get(key)
		if (known !== undefined) return known
		const grant = role.member === undefined || choice.value === null
			? { role: choice.role }
			: { role: choice.role, scope: { type: role.member.scope, value: choice.value } }
		const made = kit.testCaller([grant], { label: `${choice.role}${choice.value === null ? '' : `@${choice.value}`}` })
		callers.set(key, made)
		return made
	}

	const choiceOf = (request: Request): Choice | null => {
		const raw = cookieOf(request, CHOICE_COOKIE)
		if (raw === undefined) return null
		try {
			const parsed = Choice.safeParse(JSON.parse(decodeURIComponent(raw)))
			return parsed.success ? parsed.data : null
		} catch {
			return null
		}
	}

	const choose = (url: URL): Response => {
		const role = url.searchParams.get('role') ?? ''
		const scope = (url.searchParams.get('scope') ?? '').trim()
		const choice = Choice.safeParse({ role, value: scope === '' ? null : scope })
		if (!choice.success || callerOf(choice.data) === null) {
			return new Response(`no such caller: a role of the vocabulary, with a scope value exactly when it is a membership role\n`, {
				status: 400,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' },
			})
		}
		const cookie = `${CHOICE_COOKIE}=${encodeURIComponent(JSON.stringify(choice.data))}; Path=/; HttpOnly; SameSite=Lax`
		return new Response(null, { status: 303, headers: { Location: localPath(url.searchParams.get('next')), 'Set-Cookie': cookie } })
	}

	/** The request as it reaches the kit's origin; the page's `Origin` and `Referer` name the kit's origin instead. */
	const toKit = async (request: Request, url: URL): Promise<Request> => {
		const headers = new Headers(request.headers)
		headers.delete('Host')
		headers.delete('Referer')
		const cookies = withoutChoice(headers.get('Cookie'))
		if (cookies === null) headers.delete('Cookie')
		else headers.set('Cookie', cookies)
		if (headers.has('Origin')) headers.set('Origin', kit.origin)
		const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer()
		return new Request(new URL(`${url.pathname}${url.search}`, kit.origin), { method: request.method, headers, body, redirect: 'manual' })
	}

	/**
	 * A redirect within the kit's origin stays a local path; a sign-in, a redirect to the kit's IAM or a 401's `loginUrl`,
	 * goes to the picker instead.
	 */
	const fromKit = async (response: Response, url: URL): Promise<Response> => {
		const picker = `${PICKER_PATH}?next=${encodeURIComponent(`${url.pathname}${url.search}`)}`
		const headers = new Headers(response.headers)
		const location = response.headers.get('Location')
		if (location !== null && response.status >= 300 && response.status < 400) {
			const target = new URL(location, kit.origin)
			headers.set('Location', target.origin === kit.origin ? `${target.pathname}${target.search}` : picker)
			return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
		}
		if (response.status === 401 && (response.headers.get('Content-Type') ?? '').startsWith('application/json')) {
			const login = LoginRequired.safeParse(await response.clone().json())
			if (login.success) {
				headers.delete('Content-Length')
				const body = { error: { ...login.data.error, loginUrl: picker } }
				return new Response(JSON.stringify(body), { status: 401, statusText: response.statusText, headers })
			}
		}
		return response
	}

	const server = Bun.serve({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			const url = new URL(request.url)
			if (url.pathname === PICKER_PATH && request.method === 'GET') {
				return pickerPage(contract, choiceOf(request), localPath(url.searchParams.get('next')))
			}
			if (url.pathname === CHOOSE_PATH && request.method === 'GET') return choose(url)
			const choice = choiceOf(request)
			const caller = choice === null ? null : callerOf(choice)
			const fetch = caller === null ? kit.browser() : kit.browser(caller)
			return await fromKit(await fetch(await toKit(request, url)), url)
		},
		// The kit answers the application's own failures; anything thrown here is answered without its detail.
		error: () => new Response('app dev could not serve the request\n', { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }),
	})
	const host = options.host.includes(':') ? `[${options.host}]` : options.host
	return {
		url: `http://${host}:${server.port}/`,
		async stop() {
			await server.stop(true)
			await postgres?.close()
		},
	}
}

/** `fabrika app dev`: serves until the process is stopped, then drops the throwaway schema. */
export const runAppDevCli = async (argv: readonly string[]): Promise<void> => {
	const { port, host } = parseAppDevArgs(argv)
	const root = process.cwd()
	if (!existsSync(join(root, CONTRACT_FILE))) {
		throw new Error(`app dev: no ${CONTRACT_FILE} in ${root}; run it from the application root`)
	}
	const secret = process.env[TEST_POSTGRES_URL] ?? ''
	let server: AppDevServer
	try {
		const { default: app } = await implementationAt(join(root, IMPLEMENTATION_FILE))()
		server = await startAppDev(app, { root, port, host, env: process.env })
	} catch (error) {
		// A driver or an application error may quote the database URL, which is a credential.
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(secret === '' ? message : message.replaceAll(secret, TEST_POSTGRES_URL))
	}
	console.info(server.url)
	console.error(`fabrika app dev: pick a caller at ${server.url}${PICKER_PATH.slice(1)}; stop with Ctrl-C`)
	await new Promise<void>((resolve) => {
		const stop = () => {
			void server.stop().finally(resolve)
		}
		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)
	})
}
