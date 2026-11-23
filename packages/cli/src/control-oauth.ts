// The command-line client's OAuth half: `fabrika control auth device` asks IAM for an RFC 8628 device grant that a person
// approves in the browser, and every later Control call without FABRIKA_CONTROL_KEY refreshes an access token for the
// one console resource it calls (RFC 8707). The refresh token lives in the credential helper alone, never on stdout.
//
// IAM rotates the refresh token on every refresh and treats a second use of a spent one as a replay that revokes the
// grant. So a refresh runs under a per-origin file lock (lock, `get`, refresh, `store`, unlock), and neither a device
// code nor a refresh token is sent again after an answer that did not arrive: IAM may have spent it.

import type { RpcFetch } from '@fabrika/app'
import { OAUTH_CLI_CLIENT_ID } from '@fabrika/auth-core'
import {
	CONTROL_CLI_PRESETS,
	CONTROL_OPERATIONS_RPC_PATH,
	CONTROL_RPC_PATH,
	type ControlCliPreset,
	controlCliPresetPaths,
} from '@fabrika/control-contract'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { credentialOriginOf } from './credential-origin.js'

export const CREDENTIAL_HELPER_VARIABLE = 'FABRIKA_CONTROL_CREDENTIAL_HELPER'

/** RFC 8628 §3.4. */
const DEVICE_CODE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'

const RESTART = 'run `fabrika control auth device` again'

/** Where the refresh token lives between runs: a command with `get` and `store`, in the style of a git credential helper. */
export interface CredentialHelper {
	/** The refresh token stored for `origin`, or null when none is. */
	get(origin: string): Promise<string | null>
	store(origin: string, refreshToken: string): Promise<void>
}

/** Takes the one lock that serializes refresh-token rotation for `origin` on this machine; resolves to its release. */
export type CredentialLock = (origin: string) => Promise<() => Promise<void>>

export interface ControlOAuthDependencies {
	readonly fetch: RpcFetch
	readonly helper: CredentialHelper
	readonly lock: CredentialLock
	/** Milliseconds. */
	readonly now: () => number
	readonly sleep: (ms: number) => Promise<void>
	/** Guidance for the person running the command; it goes to stderr. */
	readonly note: (line: string) => void
}

const errorCode = (error: unknown): unknown => typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined

/**
 * `command` run by the shell with the action as its one argument, as git runs a credential helper. Its stdin carries
 * `origin=<origin>` and, for `store`, `refresh_token=<token>`; `get` prints `refresh_token=<token>`, or nothing.
 */
export function commandCredentialHelper(command: string): CredentialHelper {
	const run = async (action: 'get' | 'store', input: string): Promise<string> => {
		const child = Bun.spawn(['sh', '-c', `${command} "$@"`, CREDENTIAL_HELPER_VARIABLE, action], {
			stdin: new TextEncoder().encode(input),
			stdout: 'pipe',
			stderr: 'inherit',
		})
		const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
		// The output may hold the token, so a failure reports the exit code alone.
		if (code !== 0) throw new Error(`${CREDENTIAL_HELPER_VARIABLE} ${action} exited with ${code}`)
		return output
	}
	return {
		get: async (origin) => {
			for (const line of (await run('get', `origin=${origin}\n`)).split('\n')) {
				const matched = /^refresh_token=(\S+)$/.exec(line.trim())
				if (matched?.[1] !== undefined) return matched[1]
			}
			return null
		},
		store: async (origin, refreshToken) => {
			await run('store', `origin=${origin}\nrefresh_token=${refreshToken}\n`)
		},
	}
}

type LockState = 'absent' | 'held' | 'stale'

/** A lock file's holder: a live process, one that is gone, or none because the file went away meanwhile. */
async function lockState(path: string): Promise<LockState> {
	const text = await readFile(path, 'utf8').catch(() => null)
	if (text === null) return 'absent'
	const pid = Number(text.trim())
	// An empty file is a holder between creating and writing it.
	if (!Number.isSafeInteger(pid) || pid <= 0) return 'held'
	try {
		process.kill(pid, 0)
		return 'held'
	} catch (error) {
		return errorCode(error) === 'ESRCH' ? 'stale' : 'held'
	}
}

/**
 * An exclusive lock file per origin under `directory`, holding the holder's pid. A crashed holder's file is taken
 * over; two processes taking it over at once cost at worst one replayed refresh, which IAM answers by revoking the grant.
 */
export function fileCredentialLock(directory: string, waitMs = 30_000): CredentialLock {
	return async (origin) => {
		await mkdir(directory, { recursive: true, mode: 0o700 })
		const path = join(directory, `${createHash('sha256').update(origin).digest('hex').slice(0, 32)}.lock`)
		const deadline = Date.now() + waitMs
		for (;;) {
			try {
				const handle = await open(path, 'wx', 0o600)
				try {
					await handle.writeFile(`${process.pid}\n`)
				} finally {
					await handle.close()
				}
				return async () => {
					await unlink(path).catch(() => undefined)
				}
			} catch (error) {
				if (errorCode(error) !== 'EEXIST') throw error
			}
			const state = await lockState(path)
			if (state === 'stale') await unlink(path).catch(() => undefined)
			if (state !== 'held') continue
			if (Date.now() >= deadline) throw new Error(`Another fabrika process holds ${path}; remove the file if none is running`)
			await Bun.sleep(50)
		}
	}
}

/** The helper `command` names, the lock under the user's cache directory, and the real clock. */
export function defaultControlOAuthDependencies(
	command: string,
	env: Readonly<Record<string, string | undefined>>,
	send: RpcFetch,
): ControlOAuthDependencies {
	const xdg = env['XDG_CACHE_HOME']?.trim()
	const cache = xdg !== undefined && isAbsolute(xdg) ? xdg : join(homedir(), '.cache')
	return {
		fetch: send,
		helper: commandCredentialHelper(command),
		lock: fileCredentialLock(join(cache, 'fabrika', 'control-credentials')),
		now: Date.now,
		sleep: (ms) => Bun.sleep(ms),
		note: (line) => console.warn(line),
	}
}

interface AuthorizationServer {
	readonly issuer: string
	readonly tokenEndpoint: string
	readonly deviceEndpoint: string
}

const protectedResourceSchema = z.object({ resource: z.string(), authorization_servers: z.array(z.string()).min(1) })
const serverMetadataSchema = z.object({ issuer: z.string(), token_endpoint: z.string(), device_authorization_endpoint: z.string() })
const deviceStartSchema = z.object({
	device_code: z.string().min(1).max(256),
	user_code: z.string().regex(/^[A-Z0-9-]{4,16}$/),
	verification_uri: z.string(),
	verification_uri_complete: z.string().optional(),
	expires_in: z.number().int().positive().max(3600),
	interval: z.number().int().positive().max(60).optional(),
})
const tokensSchema = z.object({
	access_token: z.string().min(1),
	token_type: z.string().regex(/^bearer$/i),
	expires_in: z.number().int().positive(),
	refresh_token: z.string().min(1).optional(),
})
type Tokens = z.infer<typeof tokensSchema>
/** Only an error code is ever repeated from IAM's answer. */
const errorSchema = z.object({ error: z.string().regex(/^[a-z_]{1,64}$/) })

const sameOrigin = (raw: string, origin: string): boolean => {
	try {
		return new URL(raw).origin === origin
	} catch {
		return false
	}
}

/** A metadata document, or null for anything but a 200 JSON answer; a redirect is not followed. */
async function getJson(url: string, deps: ControlOAuthDependencies): Promise<unknown> {
	let response: Response
	try {
		response = await deps.fetch(url, { headers: { accept: 'application/json' }, redirect: 'manual' })
	} catch {
		throw new Error(`${new URL(url).origin} could not be reached`)
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => undefined)
		return null
	}
	return await response.json().catch(() => null)
}

/**
 * IAM's endpoints, found from Control's origin alone: the console's RPC resource names its authorization server
 * (RFC 9728), whose metadata names the endpoints (RFC 8414). Both answers decide where a credential goes, so both are
 * read without following a redirect, and every endpoint must be on the issuer's own origin.
 */
async function discover(origin: string, deps: ControlOAuthDependencies): Promise<AuthorizationServer> {
	const resource = `${origin}${CONTROL_RPC_PATH}`
	const published = protectedResourceSchema.safeParse(await getJson(`${origin}/.well-known/oauth-protected-resource${CONTROL_RPC_PATH}`, deps))
	if (!published.success || published.data.resource !== resource) {
		throw new Error(`${origin} publishes no OAuth resource for its RPC: this installation does not serve the command-line client's OAuth`)
	}
	const issuer = published.data.authorization_servers[0]
	if (issuer === undefined || credentialOriginOf(issuer) !== issuer) {
		throw new Error(`${origin} names an authorization server that is not an https origin`)
	}
	const server = serverMetadataSchema.safeParse(await getJson(`${issuer}/.well-known/oauth-authorization-server`, deps))
	if (
		!server.success || server.data.issuer !== issuer || !sameOrigin(server.data.token_endpoint, issuer)
		|| !sameOrigin(server.data.device_authorization_endpoint, issuer)
	) {
		throw new Error(`${issuer} publishes no OAuth metadata this CLI can use`)
	}
	return { issuer, tokenEndpoint: server.data.token_endpoint, deviceEndpoint: server.data.device_authorization_endpoint }
}

/** One form POST, never redirected and never retried; `lost` is the whole message when no answer arrives. */
async function postForm(url: string, form: URLSearchParams, deps: ControlOAuthDependencies, lost: string): Promise<Response> {
	try {
		return await deps.fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
			body: form.toString(),
			redirect: 'manual',
		})
	} catch {
		throw new Error(lost)
	}
}

type TokenAnswer = { readonly kind: 'tokens'; readonly tokens: Tokens } | { readonly kind: 'error'; readonly error: string }

/** The token endpoint's answer, or null when it is neither tokens nor an OAuth error this CLI can read. */
async function tokenAnswer(response: Response): Promise<TokenAnswer | null> {
	const body: unknown = await response.json().catch(() => null)
	if (response.status === 200) {
		const tokens = tokensSchema.safeParse(body)
		return tokens.success ? { kind: 'tokens', tokens: tokens.data } : null
	}
	if (response.status === 400 || response.status === 401) {
		const error = errorSchema.safeParse(body)
		return error.success ? { kind: 'error', error: error.data.error } : null
	}
	return null
}

export interface DeviceGrantRequest {
	/** Control's origin, already checked. */
	readonly origin: string
	readonly preset: ControlCliPreset
	/** The application every preset but `create` holds its actions at. */
	readonly app?: string
}

/** The preset `raw` names, or null. */
export const parseControlCliPreset = (raw: string): ControlCliPreset | null => CONTROL_CLI_PRESETS.find((preset) => preset === raw) ?? null

/**
 * The device grant: start it for the preset's resources, tell the person where to approve it, poll until they do, and
 * store the refresh token through the helper. The access token of the first resource is dropped; a call refreshes its own.
 */
export async function authorizeDevice(request: DeviceGrantRequest, deps: ControlOAuthDependencies): Promise<void> {
	const server = await discover(request.origin, deps)
	const resources = controlCliPresetPaths(request.preset).map((path) => `${request.origin}${path}`)
	const form = new URLSearchParams({
		client_id: OAUTH_CLI_CLIENT_ID,
		scope: request.app === undefined ? request.preset : `${request.preset}:${request.app}`,
	})
	for (const resource of resources) form.append('resource', resource)
	const response = await postForm(server.deviceEndpoint, form, deps, `${server.issuer} could not be reached to start the device grant`)
	if (response.status === 429) {
		await response.body?.cancel().catch(() => undefined)
		throw new Error('IAM refuses new device grants for a minute (HTTP 429); try again later')
	}
	const body: unknown = await response.json().catch(() => null)
	if (response.status !== 200) {
		const error = errorSchema.safeParse(body)
		throw new Error(`IAM refused the device grant: ${error.success ? error.data.error : `HTTP ${response.status}`}`)
	}
	const started = deviceStartSchema.safeParse(body)
	if (!started.success || !sameOrigin(started.data.verification_uri, server.issuer)) {
		throw new Error('IAM answered the device grant with a body this CLI cannot read')
	}
	const page = started.data.verification_uri_complete !== undefined && sameOrigin(started.data.verification_uri_complete, server.issuer)
		? started.data.verification_uri_complete
		: started.data.verification_uri
	deps.note(`Open ${page} and confirm the code ${started.data.user_code}.`)
	deps.note(`The person who approves picks how long the grant lasts. The code expires in ${Math.ceil(started.data.expires_in / 60)} minutes.`)
	const tokens = await pollDevice(server, started.data, resources[0] ?? `${request.origin}${CONTROL_RPC_PATH}`, deps)
	if (tokens.refresh_token === undefined) throw new Error('IAM approved the grant but issued no refresh token')
	const release = await deps.lock(request.origin)
	try {
		await deps.helper.store(request.origin, tokens.refresh_token)
	} finally {
		await release()
	}
	deps.note(`Approved. The refresh token is stored through ${CREDENTIAL_HELPER_VARIABLE}; Control calls without FABRIKA_CONTROL_KEY use it.`)
}

async function pollDevice(
	server: AuthorizationServer,
	started: z.infer<typeof deviceStartSchema>,
	resource: string,
	deps: ControlOAuthDependencies,
): Promise<Tokens> {
	const form = new URLSearchParams({ grant_type: DEVICE_CODE_GRANT_TYPE, client_id: OAUTH_CLI_CLIENT_ID, device_code: started.device_code, resource })
	let interval = started.interval ?? 5
	const deadline = deps.now() + started.expires_in * 1000
	while (deps.now() < deadline) {
		await deps.sleep(interval * 1000)
		const response = await postForm(
			server.tokenEndpoint,
			form,
			deps,
			`${server.issuer} did not answer the device code. It is not sent again, because IAM may have redeemed it; ${RESTART}`,
		)
		const answer = await tokenAnswer(response)
		if (answer === null) throw new Error(`IAM answered the device code with HTTP ${response.status}. It is not sent again; ${RESTART}`)
		if (answer.kind === 'tokens') return answer.tokens
		if (answer.error === 'authorization_pending') continue
		if (answer.error === 'slow_down') {
			interval += 5
			continue
		}
		if (answer.error === 'access_denied') throw new Error('The grant was denied in the browser')
		if (answer.error === 'expired_token') break
		throw new Error(`IAM refused the device code: ${answer.error}`)
	}
	throw new Error(`The code expired before anyone approved it; ${RESTART}`)
}

/** A current access token for one of the console's resources. */
export type ControlBearer = (resource: string) => Promise<string>

/**
 * Access tokens for `origin`'s resources, refreshed through the helper's grant as a call needs them and kept in this
 * process's memory only. Concurrent calls for one resource share one refresh.
 */
export function controlOAuthBearer(origin: string, deps: ControlOAuthDependencies): ControlBearer {
	let server: Promise<AuthorizationServer> | undefined
	const held = new Map<string, { readonly token: string; readonly refreshAt: number }>()
	const pending = new Map<string, Promise<string>>()
	const refresh = async (resource: string): Promise<string> => {
		server ??= discover(origin, deps)
		const { issuer, tokenEndpoint } = await server
		const release = await deps.lock(origin)
		try {
			const stored = await deps.helper.get(origin)
			if (stored === null) throw new Error(`${CREDENTIAL_HELPER_VARIABLE} holds no grant for ${origin}; run \`fabrika control auth device\` first`)
			const form = new URLSearchParams({ grant_type: 'refresh_token', client_id: OAUTH_CLI_CLIENT_ID, refresh_token: stored, resource })
			const response = await postForm(
				tokenEndpoint,
				form,
				deps,
				`${issuer} did not answer the refresh. If it arrived there, the stored refresh token is spent and the next call fails; then ${RESTART}`,
			)
			const answer = await tokenAnswer(response)
			if (answer === null) throw new Error(`IAM answered the refresh with HTTP ${response.status}`)
			if (answer.kind === 'error') {
				throw new Error(
					answer.error === 'invalid_grant'
						? `The grant for ${origin} expired, was revoked, or its refresh token was used twice; ${RESTART}`
						: `IAM refused the refresh: ${answer.error}`,
				)
			}
			const rotated = answer.tokens.refresh_token
			if (rotated !== undefined) {
				try {
					await deps.helper.store(origin, rotated)
				} catch (error) {
					const reason = error instanceof Error ? error.message : 'it failed'
					throw new Error(`IAM rotated the refresh token, but storing the new one failed (${reason}); the stored one is spent: ${RESTART}`)
				}
			}
			// Refreshed 30 seconds early, so a token does not expire between this check and Control's.
			held.set(resource, { token: answer.tokens.access_token, refreshAt: deps.now() + Math.max(0, answer.tokens.expires_in - 30) * 1000 })
			return answer.tokens.access_token
		} finally {
			await release()
		}
	}
	return (resource) => {
		const token = held.get(resource)
		if (token !== undefined && deps.now() < token.refreshAt) return Promise.resolve(token.token)
		const running = pending.get(resource)
		if (running !== undefined) return running
		const started = refresh(resource).finally(() => pending.delete(resource))
		pending.set(resource, started)
		return started
	}
}

const onPath = (pathname: string, path: string): boolean => pathname === path || pathname.startsWith(`${path}/`)

/** The console resource a request needs: the Operations RPC, or Control's own. A bearer never leaves Control's origin. */
export function controlResourceFor(origin: string, input: RequestInfo | URL): string {
	const url = new URL(input instanceof Request ? input.url : input)
	if (url.origin !== origin) throw new Error(`A Control credential is sent to ${origin} only`)
	return `${origin}${onPath(url.pathname, CONTROL_OPERATIONS_RPC_PATH) ? CONTROL_OPERATIONS_RPC_PATH : CONTROL_RPC_PATH}`
}
