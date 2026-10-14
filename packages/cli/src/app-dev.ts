// `fabrika app dev`: a contract application served through its test kit on a loopback port, to click through its
// screens. The kit is the whole server: production's proxy decision, the stand-in IAM, the real `boot`, the SPAs from
// their build directories; Postgres is a throwaway schema of the tests' database. A seed module fills it through the
// endpoints first. A caller picker chooses who the browser is; a cookie keeps the choice, and the kit's own session
// never leaves the process. Every SPA page gets the dev toolbar, which switches the caller without leaving the page.

import { CONTRACT_FILE, IMPLEMENTATION_FILE } from '@fabrika/app/build'
import { implementationAt } from '@fabrika/app/bun'
import type { AnyContract } from '@fabrika/app/contract'
import { BootError, type ContractImplementation } from '@fabrika/app/implement'
import { DEV_OUTBOX_ORIGIN, type DevKit, devKit, type DevOutside, type LabelledTestCaller, type TestCaller } from '@fabrika/app/testing'
import { TEST_POSTGRES_URL, type TestDatabase, testDatabase } from '@fabrika/db/testing'
import { PostgresMigrationError } from '@fabrika/platform-node'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { DEV_ENV_FILE, DevEnvProblem, devOutbox, mailHeadOf, readDevEnv, shownBody } from './app-dev-outside'
import { DEFAULT_SEED, importSeed, isLocalPath, NOTHING_SEEDED, parseSeeded, type Seeded, seedPath, SeedProblem } from './app-dev-seed'
import {
	type Badge,
	type CurrentView,
	type DevView,
	type MailView,
	noticePage,
	pickerPage,
	type RoleView,
	stringsOf,
	toolbarScript,
	toolbarState,
	withToolbar,
} from './app-dev-ui'

export const APP_DEV_USAGE = `fabrika app dev — the application on a local port, to click through its screens

Usage:
  fabrika app dev [--port=<n>] [--host=<loopback address>] [--seed=<module>]

Run from the application root. It serves ${IMPLEMENTATION_FILE} through its test kit: the production proxy decision,
the kit's stand-in IAM, each SPA from its built directory (run the SPA build first; an unbuilt one is an empty page),
and a throwaway schema of the database in ${TEST_POSTGRES_URL}, migrated from db/migrations/ and dropped on exit.
The seed module (--seed, or ${DEFAULT_SEED} when it exists) default-exports a DevSeed of @fabrika/app/testing: it
receives the kit, writes through the endpoints, and answers the personas, link pages and scope values to offer.
Pick who the browser is at /__fabrika/dev; every SPA page shows a toolbar that switches the caller and lists the
mail IAM sent and the requests the application sent to ${DEV_OUTBOX_ORIGIN}, the dev outbox. A form's challenge
passes. The application's own variables come from ${DEV_ENV_FILE} (NAME=value lines) over the environment. What the
seed or a job's handler throws is printed with its stack. It listens on 127.0.0.1 (or ::1, localhost) only, port
3000 unless --port says otherwise (0 picks a free one), and prints the address it serves.
`

const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost'])
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost'])
const PICKER_PATH = '/__fabrika/dev'
const CHOOSE_PATH = '/__fabrika/dev/as'
const ACCEPT_PATH = '/__fabrika/dev/accept'
const STATE_PATH = '/__fabrika/dev/state'
const OUTBOX_PATH = '/__fabrika/dev/outbox/'
const TOOLBAR_PATH = '/__fabrika/dev/toolbar.js'
const CHOICE_COOKIE = 'fabrika-dev-as'
const MAX_SCOPE_VALUE = 200

/** What `app dev`'s own pages answer with: nothing runs there but the toolbar, which is a separate response. */
const PAGE_HEADERS = {
	'Content-Type': 'text/html; charset=utf-8',
	'Cache-Control': 'no-store',
	'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
	'X-Content-Type-Options': 'nosniff',
	'Referrer-Policy': 'no-referrer',
}

/** A refusal of `app dev` itself, whose message names nothing of the environment. */
export class AppDevError extends Error {
	override readonly name = 'AppDevError'
}

/**
 * What of a startup failure reaches the terminal: the message of `app dev`'s own refusal (the seed's own throw, with its
 * stack, included), of the seed's answer, of `dev/dev.env`, of the framework's boot and of the migration runner;
 * anything else (an application module, a driver, a dependency `deps` built) may carry a credential, so it is a fixed
 * code.
 */
export function startupFailure(error: unknown): Error {
	if (
		error instanceof AppDevError || error instanceof SeedProblem || error instanceof DevEnvProblem || error instanceof BootError
		|| error instanceof PostgresMigrationError
	) {
		return new Error(error.message)
	}
	return new Error('app dev could not start: start_failed (the error is withheld: it may contain a credential)')
}

export interface AppDevOptions {
	/** The application root. */
	readonly root: string
	readonly port: number
	readonly host: string
	/** The environment: the test database URL, and the application's own variables. */
	readonly env: Readonly<Record<string, string | undefined>>
	/** The seed module's absolute path, or `null` to serve the empty application. */
	readonly seed: string | null
}

export interface AppDevServer {
	/** The address it serves, `http://<host>:<port>/`. */
	readonly url: string
	/** How many personas and link pages the seed offered. */
	readonly seeded: { readonly personas: number; readonly links: number }
	/** Stops serving and drops the throwaway schema. */
	stop(): Promise<void>
}

/** Who the browser is: a persona of the seed, a role of the vocabulary in a scope value, or who accepted an invitation. */
const Choice = z.union([
	z.strictObject({ persona: z.string().min(1).max(200) }),
	z.strictObject({ role: z.string().min(1), value: z.string().min(1).max(MAX_SCOPE_VALUE).nullable() }),
	z.strictObject({ invitation: z.string().min(1).max(200) }),
])
type Choice = z.infer<typeof Choice>

/** The proxy's sign-in answer to a fetch, whose `loginUrl` names the kit's IAM. */
const LoginRequired = z.object({ error: z.looseObject({ loginUrl: z.string() }) })

export interface AppDevArgs {
	readonly port: number
	readonly host: string
	readonly seed: string | null
}

export function parseAppDevArgs(argv: readonly string[]): AppDevArgs {
	let port = 3000
	let host = '127.0.0.1'
	let seed: string | null = null
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? ''
		if (arg.startsWith('--port=')) {
			const parsed = Number(arg.slice('--port='.length))
			if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) throw new Error(`app dev: --port is 0 to 65535, not ${arg.slice(7)}`)
			port = parsed
		} else if (arg.startsWith('--host=')) {
			host = arg.slice('--host='.length)
		} else if (arg.startsWith('--seed=') || arg === '--seed') {
			const value = arg === '--seed' ? argv[index += 1] : arg.slice('--seed='.length)
			if (value === undefined || value === '') throw new Error(`app dev: --seed names a module, e.g. --seed=${DEFAULT_SEED}`)
			seed = value
		} else {
			throw new Error(`app dev takes no argument ${arg}\n\n${APP_DEV_USAGE}`)
		}
	}
	if (!LOOPBACK.has(host)) {
		throw new Error(`app dev serves this machine only: --host is 127.0.0.1, ::1 or localhost, not ${host}`)
	}
	return { port, host, seed }
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

/** The request is addressed to this server by a loopback name: a page of another site rebound to 127.0.0.1 is not. */
function addressedHere(request: Request, port: number): boolean {
	const host = request.headers.get('Host')
	if (host === null) return false
	const at = host.lastIndexOf(':')
	return at > 0 && LOOPBACK_HOSTNAMES.has(host.slice(0, at)) && host.slice(at + 1) === String(port)
}

const plain = (status: number, text: string): Response =>
	new Response(`${text}\n`, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })

/** Serves `app` through its test kit on a loopback port until `stop`. */
export async function startAppDev(app: ContractImplementation<AnyContract>, options: AppDevOptions): Promise<AppDevServer> {
	if (!LOOPBACK.has(options.host)) throw new AppDevError(`app dev serves this machine only, not ${options.host}`)
	let postgres: TestDatabase | null = null
	if (app.database !== null) {
		if ((options.env[TEST_POSTGRES_URL] ?? '') === '') {
			throw new AppDevError(`app dev needs ${TEST_POSTGRES_URL}, the database the tests use: it migrates a throwaway schema there`)
		}
		postgres = await testDatabase({ migrations: join(options.root, 'db', 'migrations'), label: 'fabrika app dev' })
	}
	try {
		return await serveThroughKit(app, options, postgres)
	} catch (error) {
		// The schema and its roles exist from here on: a failed start drops them as a stop does.
		await postgres?.close()
		throw error
	}
}

/**
 * The seed's answer, and its answer's problems named. What its own code throws is printed whole, stack included: the
 * developer's code on the developer's machine.
 */
async function runSeed(dev: DevKit<AnyContract>, outside: DevOutside, path: string | null): Promise<Seeded> {
	if (path === null) return NOTHING_SEEDED
	let answer: unknown
	try {
		const seed = await importSeed(path)
		answer = await seed(dev.kit, outside)
	} catch (error) {
		if (error instanceof SeedProblem) throw error
		throw new AppDevError(`app dev could not seed: the seed threw\n${Bun.inspect(error)}`)
	}
	return parseSeeded(dev, answer)
}

/** What a job's handler threw, printed whole on the developer's terminal. */
const printHandlerError = (where: string, error: unknown): void => {
	console.error(`fabrika app dev: ${where} threw\n${Bun.inspect(error)}`)
}

/**
 * The server over the kit of `app`, on `postgres` when it has a data layer; its `stop` also drops the schema. The dev
 * outbox captures the process's `fetch` from before the seed runs until `stop`, or until a failed start.
 */
async function serveThroughKit(
	app: ContractImplementation<AnyContract>,
	options: AppDevOptions,
	postgres: TestDatabase | null,
): Promise<AppDevServer> {
	const outbox = devOutbox()
	const restoreFetch = outbox.install()
	try {
		return await serveDevKit(app, options, postgres, outbox, restoreFetch)
	} catch (error) {
		restoreFetch()
		throw error
	}
}

async function serveDevKit(
	app: ContractImplementation<AnyContract>,
	options: AppDevOptions,
	postgres: TestDatabase | null,
	outbox: DevOutside,
	restoreFetch: () => void,
): Promise<AppDevServer> {
	const contract = app.contract
	const vocabulary = contract.vocabulary
	const hasFiles = Object.keys(contract.surface.files ?? {}).length > 0
	const dev = devKit(app, {
		root: options.root,
		env: { ...applicationVariables(options.env), ...readDevEnv(options.root) },
		...(postgres === null ? {} : { database: postgres.database }),
		...(hasFiles ? { files: new MemoryFileObjects() } : {}),
		revealHandlerErrors: printHandlerError,
	})
	const kit = dev.kit
	const seeded = await runSeed(dev, outbox, options.seed)
	const text = stringsOf(vocabulary.locale ?? 'en')
	const title = vocabulary.displayName ?? vocabulary.app
	const mounts = Object.values(kit.artifact.mounts)
	const firstSpa = mounts.find((mount) => mount.kind === 'spa')?.prefix ?? '/'
	const pagePrefixes = mounts.flatMap((mount) => (mount.kind === 'spa' || mount.kind === 'link' ? [mount.prefix] : []))
	const callers = new Map<string, LabelledTestCaller>()
	const invitees = new Map<string, LabelledTestCaller>()
	const toolbar = toolbarScript(STATE_PATH)

	/** A path of this origin to go on to; anything else is the first SPA. */
	const nextOf = (next: string | null): string => (next !== null && isLocalPath(next) ? next : firstSpa)

	/** The caller a role choice names, made once and kept, so its membership changes last; `null` when it is no grant. */
	const roleCaller = (role: string, value: string | null): LabelledTestCaller | null => {
		const declared = Object.hasOwn(vocabulary.roles, role) ? vocabulary.roles[role] : undefined
		if (declared === undefined || (declared.member !== undefined) !== (value !== null)) return null
		const key = JSON.stringify([role, value])
		const known = callers.get(key)
		if (known !== undefined) return known
		const grant = declared.member === undefined || value === null ? { role } : { role, scope: { type: declared.member.scope, value } }
		const made = kit.testCaller([grant], { label: `${role}${value === null ? '' : `@${value}`}` })
		callers.set(key, made)
		return made
	}

	const callerOf = (choice: Choice): LabelledTestCaller | null => {
		if ('persona' in choice) return seeded.personas.find((persona) => persona.name === choice.persona)?.caller ?? null
		if ('invitation' in choice) return invitees.get(choice.invitation) ?? null
		return roleCaller(choice.role, choice.value)
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

	const scopeLabel = (type: string, value: string): string => seeded.scopes.get(type)?.find((known) => known.value === value)?.label ?? value

	const externalBadge: Badge = { text: text.external, tone: 'external' }
	const badgesOf = (caller: TestCaller): Badge[] => [
		...dev.membershipsOf(caller).map((held): Badge => ({
			text: held.scope === null ? held.role : `${held.role} · ${scopeLabel(held.scope.type, held.scope.value)}`,
			tone: 'role',
		})),
		...(caller.affiliation === 'external' ? [externalBadge] : []),
	]

	const currentOf = (choice: Choice | null): CurrentView | null => {
		const caller = choice === null ? null : callerOf(choice)
		if (choice === null || caller === null) return null
		if ('persona' in choice) return { name: choice.persona, badges: badgesOf(caller) }
		return { name: caller.email ?? caller.label, badges: badgesOf(caller) }
	}

	const chooseHref = (params: Record<string, string>, next: string): string => `${CHOOSE_PATH}?${new URLSearchParams({ ...params, next }).toString()}`

	/** The values a membership role is offered in: the seed's, then those its personas hold. */
	const valuesOf = (dimension: string): { readonly value: string; readonly label: string }[] => {
		const values = [...(seeded.scopes.get(dimension) ?? [])]
		for (const persona of seeded.personas) {
			for (const held of dev.membershipsOf(persona.caller)) {
				if (held.scope?.type === dimension && !values.some((known) => known.value === held.scope?.value)) {
					values.push({ value: held.scope.value, label: held.scope.value })
				}
			}
		}
		return values
	}

	const viewOf = (choice: Choice | null, next: string): DevView => ({
		locale: vocabulary.locale ?? 'en',
		title,
		current: currentOf(choice),
		personas: seeded.personas.map((persona) => ({
			name: persona.name,
			description: persona.description,
			email: persona.caller.email,
			badges: badgesOf(persona.caller),
			href: chooseHref({ persona: persona.name }, next),
			current: choice !== null && 'persona' in choice && choice.persona === persona.name,
		})),
		roles: Object.entries(vocabulary.roles).map(([role, declared]): RoleView => ({
			role,
			grants: declared.grants,
			external: declared.external === true,
			choose: declared.member === undefined
				? { kind: 'app', href: chooseHref({ role }, next) }
				: { kind: 'member', action: CHOOSE_PATH, next, dimension: declared.member.scope, values: valuesOf(declared.member.scope) },
		})),
		anonymousHref: chooseHref({ anonymous: '1' }, next),
		links: seeded.links.map((link) => ({ title: link.title, description: link.description, href: link.url })),
		mail: [
			...dev.invitations().map((invitation): MailView => ({
				to: invitation.email,
				subject: text.invitation(invitation.role, scopeLabel(invitation.scope.type, invitation.scope.value)),
				status: invitation.status,
				action: invitation.status === 'open'
					? { label: text.accept, href: `${ACCEPT_PATH}?${new URLSearchParams({ invitation: invitation.id, next }).toString()}` }
					: invitation.status === 'accepted' && invitees.has(invitation.id)
					? { label: text.continueAs, href: chooseHref({ invitation: invitation.id }, next) }
					: null,
			})),
			...outbox.outbox().map((message): MailView => ({
				...mailHeadOf(message),
				status: 'sent',
				action: { label: text.openMessage, href: `${OUTBOX_PATH}${message.id}` },
			})),
		],
		pickerHref: `${PICKER_PATH}?${new URLSearchParams({ next }).toString()}`,
	})

	const choosing = (choice: Choice | null, next: string): Response => {
		const cookie = choice === null
			? `${CHOICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
			: `${CHOICE_COOKIE}=${encodeURIComponent(JSON.stringify(choice))}; Path=/; HttpOnly; SameSite=Lax`
		return new Response(null, { status: 303, headers: { Location: next, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' } })
	}

	const choose = (url: URL): Response => {
		const next = nextOf(url.searchParams.get('next'))
		const persona = url.searchParams.get('persona')
		const invitation = url.searchParams.get('invitation')
		if (url.searchParams.has('anonymous')) return choosing(null, next)
		if (persona !== null) {
			const choice = Choice.safeParse({ persona })
			if (!choice.success || callerOf(choice.data) === null) return plain(400, 'no such persona: the seed answered none by that name')
			return choosing(choice.data, next)
		}
		if (invitation !== null) {
			const choice = Choice.safeParse({ invitation })
			if (!choice.success || callerOf(choice.data) === null) return plain(400, 'no such invitee: nobody accepted that invitation here')
			return choosing(choice.data, next)
		}
		const role = url.searchParams.get('role') ?? ''
		const scope = (url.searchParams.get('scope') ?? '').trim()
		const choice = Choice.safeParse({ role, value: scope === '' ? null : scope })
		if (!choice.success || callerOf(choice.data) === null) {
			return plain(400, 'no such caller: a role of the vocabulary, with a scope value exactly when it is a membership role')
		}
		return choosing(choice.data, next)
	}

	/** The addressee of an open invitation accepts it, as IAM's onboarding does, and the browser is that person from now on. */
	const accept = (request: Request, url: URL): Response => {
		const next = nextOf(url.searchParams.get('next'))
		const id = url.searchParams.get('invitation') ?? ''
		try {
			invitees.set(id, kit.acceptInvitation(id))
		} catch (error) {
			const view = viewOf(choiceOf(request), next)
			// The kit's refusal names the invitation and the role, never a credential.
			return new Response(noticePage(view, text.accept, error instanceof Error ? error.message : 'not_allowed'), { status: 409, headers: PAGE_HEADERS })
		}
		return choosing({ invitation: id }, next)
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

	const isPage = (path: string): boolean =>
		pagePrefixes.some((prefix) => prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`))

	/** An SPA page with the toolbar's script tag; the kit's policy (`script-src 'self'`) already admits that script. */
	const withDevToolbar = async (request: Request, response: Response, url: URL): Promise<Response> => {
		if (
			request.method !== 'GET' || response.status !== 200 || !(response.headers.get('Content-Type') ?? '').startsWith('text/html')
			|| !isPage(url.pathname)
		) {
			return response
		}
		const headers = new Headers(response.headers)
		headers.delete('Content-Length')
		headers.delete('ETag')
		return new Response(withToolbar(await response.text(), TOOLBAR_PATH), { status: 200, statusText: response.statusText, headers })
	}

	/** A message of the dev outbox, its body as it came (JSON indented); its headers, which carry keys, are not kept. */
	const outboxMessage = (path: string): Response => {
		const message = outbox.outbox().find((candidate) => `${OUTBOX_PATH}${candidate.id}` === path)
		if (message === undefined) return plain(404, 'no such message in the dev outbox')
		return new Response(`${message.method} ${DEV_OUTBOX_ORIGIN}${message.path}\n\n${shownBody(message)}\n`, {
			headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
		})
	}

	const devRoute = (request: Request, url: URL): Response | null => {
		if (request.method !== 'GET') return null
		if (url.pathname.startsWith(OUTBOX_PATH)) return outboxMessage(url.pathname)
		switch (url.pathname) {
			case PICKER_PATH:
				return new Response(pickerPage(viewOf(choiceOf(request), nextOf(url.searchParams.get('next')))), { headers: PAGE_HEADERS })
			case CHOOSE_PATH:
				return choose(url)
			case ACCEPT_PATH:
				return accept(request, url)
			case STATE_PATH:
				return Response.json(toolbarState(viewOf(choiceOf(request), nextOf(url.searchParams.get('next')))), {
					headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
				})
			case TOOLBAR_PATH:
				return new Response(toolbar, {
					headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
				})
			default:
				return null
		}
	}

	let port = options.port
	const server = listen({
		hostname: options.host,
		port: options.port,
		async fetch(request) {
			if (!addressedHere(request, port)) return plain(421, 'app dev answers only requests addressed to its loopback address')
			const url = new URL(request.url)
			const own = devRoute(request, url)
			if (own !== null) return own
			const choice = choiceOf(request)
			const caller = choice === null ? null : callerOf(choice)
			const fetch = caller === null ? kit.browser() : kit.browser(caller)
			return await withDevToolbar(request, await fromKit(await fetch(await toKit(request, url)), url), url)
		},
		// The kit answers the application's own failures; anything thrown here is answered without its detail.
		error: () => plain(500, 'app dev could not serve the request'),
	})
	port = server.port ?? options.port
	const host = options.host.includes(':') ? `[${options.host}]` : options.host
	return {
		url: `http://${host}:${port}/`,
		seeded: { personas: seeded.personas.length, links: seeded.links.length },
		async stop() {
			try {
				await server.stop(true)
			} finally {
				restoreFetch()
				await postgres?.close()
			}
		},
	}
}

/** `Bun.serve`, with a port another process holds named as such. */
function listen(serving: Parameters<typeof Bun.serve>[0]): ReturnType<typeof Bun.serve> {
	try {
		return Bun.serve(serving)
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EADDRINUSE') {
			throw new AppDevError(
				`app dev: port ${String(serving.port)} on ${String(serving.hostname)} is in use; pass --port=<n>, or --port=0 for a free one`,
			)
		}
		throw error
	}
}

/** `fabrika app dev`: serves until the process is stopped, then drops the throwaway schema. */
export const runAppDevCli = async (argv: readonly string[]): Promise<void> => {
	const { port, host, seed: given } = parseAppDevArgs(argv)
	const root = process.cwd()
	if (!existsSync(join(root, CONTRACT_FILE))) {
		throw new Error(`app dev: no ${CONTRACT_FILE} in ${root}; run it from the application root`)
	}
	let server: AppDevServer
	try {
		const seed = seedPath(root, given)
		const { default: app } = await implementationAt(join(root, IMPLEMENTATION_FILE))()
		server = await startAppDev(app, { root, port, host, env: process.env, seed })
	} catch (error) {
		throw startupFailure(error)
	}
	console.info(server.url)
	const { personas, links } = server.seeded
	console.error(
		`fabrika app dev: seeded personas: ${personas}, link pages: ${links}; pick a caller at ${server.url}${PICKER_PATH.slice(1)}; stop with Ctrl-C`,
	)
	await new Promise<void>((resolve) => {
		const stop = () => {
			void server.stop().finally(resolve)
		}
		process.once('SIGINT', stop)
		process.once('SIGTERM', stop)
	})
}
