import { RpcError, type RpcFetch } from '@fabrika/app'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, unlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	authorizeDevice,
	commandCredentialHelper,
	controlOAuthBearer,
	type ControlOAuthDependencies,
	type CredentialHelper,
	type CredentialLock,
	fileCredentialLock,
} from '../control-oauth.js'
import { connectControl, controlTransport, MISSING_CONTROL_CREDENTIAL } from '../control.js'

const CONSOLE = 'https://console.example.test'
const IAM = 'https://iam.example.test'
const RPC = `${CONSOLE}/api/rpc`
const OPERATIONS_RPC = `${CONSOLE}/operations/api/rpc`

interface TokenCall {
	readonly grantType: string | null
	readonly resource: string | null
	readonly refreshToken: string | null
}

/**
 * Control's resource metadata and IAM's OAuth endpoints. Refresh tokens rotate, and a spent one revokes the grant, as
 * IAM does. `pollAnswers` are the device-code answers in order.
 */
function fakeInstallation(
	options: {
		pollAnswers?: readonly (Response | 'lost')[]
		metadata?: () => Response
		/** The resources the grant covers; a refresh for another is refused unspent, as IAM does. */
		covers?: readonly string[]
		/** Replaces the device start's answer. */
		start?: () => Response
	} = {},
) {
	const calls: string[] = []
	const tokenCalls: TokenCall[] = []
	const starts: URLSearchParams[] = []
	const live = new Set<string>()
	const spent = new Set<string>()
	let revoked = false
	let serial = 0
	const polls = [...(options.pollAnswers ?? [])]
	const issue = (resource: string): Response => {
		const refresh = `rt-${++serial}`
		live.add(refresh)
		return Response.json({ access_token: `at-${serial}:${resource}`, token_type: 'Bearer', expires_in: 300, refresh_token: refresh })
	}
	const fetch: RpcFetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input)
		const method = init?.method ?? 'GET'
		calls.push(`${method} ${url}`)
		if (url === `${CONSOLE}/.well-known/oauth-protected-resource/api/rpc`) {
			return options.metadata?.() ?? Response.json({ resource: RPC, authorization_servers: [IAM] })
		}
		if (url === `${IAM}/.well-known/oauth-authorization-server`) {
			return Response.json({ issuer: IAM, token_endpoint: `${IAM}/oauth/token`, device_authorization_endpoint: `${IAM}/oauth/device_authorization` })
		}
		const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '')
		if (url === `${IAM}/oauth/device_authorization`) {
			starts.push(form)
			if (options.start !== undefined) return options.start()
			return Response.json({
				device_code: 'device-code-1',
				user_code: 'BCDF-GHJK',
				verification_uri: `${IAM}/oauth/device`,
				verification_uri_complete: `${IAM}/oauth/device?user_code=BCDF-GHJK`,
				expires_in: 300,
				interval: 5,
			})
		}
		if (url === `${IAM}/oauth/token`) {
			const call = { grantType: form.get('grant_type'), resource: form.get('resource'), refreshToken: form.get('refresh_token') }
			tokenCalls.push(call)
			if (call.grantType === 'urn:ietf:params:oauth:grant-type:device_code') {
				const answer = polls.shift() ?? issue(call.resource ?? '')
				if (answer === 'lost') throw new TypeError('socket closed')
				return answer
			}
			const token = call.refreshToken ?? ''
			if (options.covers !== undefined && !options.covers.includes(call.resource ?? '') && live.has(token)) {
				return Response.json({ error: 'invalid_target' }, { status: 400 })
			}
			if (revoked || spent.has(token) || !live.has(token)) {
				// A spent refresh token is a replay: IAM revokes the whole grant.
				if (spent.has(token)) revoked = true
				return Response.json({ error: 'invalid_grant' }, { status: 400 })
			}
			live.delete(token)
			spent.add(token)
			return issue(call.resource ?? '')
		}
		return new Response('not found', { status: 404 })
	}
	return {
		fetch,
		calls,
		tokenCalls,
		starts,
		/** A grant IAM issued, as `auth device` would have stored it. */
		grant: (): string => {
			const refresh = `rt-${++serial}`
			live.add(refresh)
			return refresh
		},
		get revoked() {
			return revoked
		},
	}
}

/** The helper's store, shared by every "process" of a test; `get` yields first, as a real command would. */
function memoryHelper(initial: string | null = null) {
	let stored = initial
	const log: string[] = []
	let failStore = false
	const helper: CredentialHelper = {
		get: async (origin) => {
			await Bun.sleep(1)
			log.push(`get ${origin}`)
			return stored
		},
		store: async (origin, token) => {
			await Bun.sleep(1)
			log.push(`store ${origin}`)
			if (failStore) throw new Error('helper store exited with 1')
			stored = token
		},
	}
	return {
		helper,
		log,
		get stored() {
			return stored
		},
		failNextStores: () => {
			failStore = true
		},
	}
}

const noLock: CredentialLock = () => Promise.resolve(() => Promise.resolve())

const directories: string[] = []
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const scratch = async (): Promise<string> => {
	const directory = await mkdtemp(join(tmpdir(), 'fabrika-control-oauth-'))
	directories.push(directory)
	return directory
}

function dependencies(
	installation: ReturnType<typeof fakeInstallation>,
	helper: CredentialHelper,
	overrides: Partial<ControlOAuthDependencies> = {},
): ControlOAuthDependencies & { readonly notes: string[]; readonly sleeps: number[] } {
	const notes: string[] = []
	const sleeps: number[] = []
	let clock = 1_000_000
	return {
		fetch: installation.fetch,
		helper,
		lock: noLock,
		now: () => clock,
		sleep: (ms) => {
			sleeps.push(ms)
			clock += ms
			return Promise.resolve()
		},
		note: (line) => notes.push(line),
		notes,
		sleeps,
		...overrides,
	}
}

describe('fabrika control auth device', () => {
	test("asks for the preset's resources at one app, waits for the approval, and stores only the refresh token", async () => {
		const installation = fakeInstallation({
			pollAnswers: [Response.json({ error: 'authorization_pending' }, { status: 400 }), Response.json({ error: 'slow_down' }, { status: 400 })],
		})
		const store = memoryHelper()
		const deps = dependencies(installation, store.helper)
		await authorizeDevice({ origin: CONSOLE, preset: 'deploy', app: 'alpha' }, deps)

		const start = installation.starts[0]
		expect(start?.get('client_id')).toBe('fabrika-cli')
		expect(start?.get('scope')).toBe('deploy:alpha')
		expect(start?.getAll('resource')).toEqual([RPC, OPERATIONS_RPC])
		// The interval IAM named, then five seconds more after `slow_down`.
		expect(deps.sleeps).toEqual([5000, 5000, 10_000])
		expect(installation.tokenCalls.map((call) => call.resource)).toEqual([RPC, RPC, RPC])
		expect(store.stored).toBe('rt-1')
		expect(deps.notes[0]).toBe(`Open ${IAM}/oauth/device?user_code=BCDF-GHJK and confirm the code BCDF-GHJK.`)
		expect(deps.notes.join('\n')).not.toContain('rt-1')
		expect(deps.notes.join('\n')).not.toContain('at-1')
	})

	test('`create` asks for the console RPC alone, with no app', async () => {
		const installation = fakeInstallation()
		await authorizeDevice({ origin: CONSOLE, preset: 'create' }, dependencies(installation, memoryHelper().helper))
		expect(installation.starts[0]?.get('scope')).toBe('create')
		expect(installation.starts[0]?.getAll('resource')).toEqual([RPC])
	})

	test('never sends the device code again after an answer that did not arrive', async () => {
		const installation = fakeInstallation({ pollAnswers: [Response.json({ error: 'authorization_pending' }, { status: 400 }), 'lost'] })
		const store = memoryHelper()
		await expect(authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(installation, store.helper))).rejects.toThrow(
			'It is not sent again, because IAM may have redeemed it',
		)
		expect(installation.tokenCalls).toHaveLength(2)
		expect(store.stored).toBeNull()
	})

	test('a refused start and an expired code end it without storing anything', async () => {
		const busy = fakeInstallation({ start: () => Response.json({ error: 'temporarily_unavailable' }, { status: 429 }) })
		await expect(authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(busy, memoryHelper().helper))).rejects.toThrow(
			'IAM refuses new device grants for a minute (HTTP 429)',
		)
		expect(busy.tokenCalls).toHaveLength(0)
		const store = memoryHelper()
		const expired = fakeInstallation({ pollAnswers: [Response.json({ error: 'expired_token' }, { status: 400 })] })
		await expect(authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(expired, store.helper))).rejects.toThrow(
			'The code expired before anyone approved it',
		)
		expect(expired.tokenCalls).toHaveLength(1)
		expect(store.stored).toBeNull()
	})

	test('a denial and an unreadable answer end it without storing anything', async () => {
		for (
			const [answer, message] of [
				[Response.json({ error: 'access_denied' }, { status: 400 }), 'denied in the browser'],
				[new Response('bad gateway', { status: 502 }), 'HTTP 502. It is not sent again'],
			] as const
		) {
			const store = memoryHelper()
			await expect(
				authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(fakeInstallation({ pollAnswers: [answer] }), store.helper)),
			).rejects.toThrow(message)
			expect(store.stored).toBeNull()
		}
	})

	test('follows no redirect while it finds IAM, and sends nothing to an authorization server off https', async () => {
		const redirected = fakeInstallation({ metadata: () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }) })
		await expect(authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(redirected, memoryHelper().helper))).rejects
			.toThrow('publishes no OAuth resource for its RPC')
		const plain = fakeInstallation({ metadata: () => Response.json({ resource: RPC, authorization_servers: ['http://iam.example.test'] }) })
		await expect(authorizeDevice({ origin: CONSOLE, preset: 'read', app: 'alpha' }, dependencies(plain, memoryHelper().helper))).rejects
			.toThrow('not an https origin')
		for (const installation of [redirected, plain]) expect(installation.calls.some((call) => call.startsWith('POST'))).toBe(false)
	})
})

describe('the access token of a Control call', () => {
	test('refreshes once per resource and process, and stores every rotated refresh token', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper(null)
		const bearer = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper))
		await expect(bearer(RPC)).rejects.toThrow('holds no grant')
		const deps = dependencies(installation, memoryHelper(installation.grant()).helper)
		const fresh = controlOAuthBearer(CONSOLE, deps)
		const [first, again] = await Promise.all([fresh(RPC), fresh(RPC)])
		expect(first).toBe(again)
		expect(await fresh(RPC)).toBe(first)
		expect(await fresh(OPERATIONS_RPC)).toContain(OPERATIONS_RPC)
		expect(installation.tokenCalls.map((call) => call.resource)).toEqual([RPC, OPERATIONS_RPC])
		expect(installation.revoked).toBe(false)
	})

	test('two processes on one machine rotate one after the other under the file lock, and IAM sees no replay', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper(installation.grant())
		const lock = fileCredentialLock(await scratch())
		const one = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper, { lock }))
		const two = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper, { lock }))
		await Promise.all([one(RPC), two(RPC), one(OPERATIONS_RPC), two(OPERATIONS_RPC)])
		const used = installation.tokenCalls.map((call) => call.refreshToken)
		expect(used).toEqual(['rt-1', 'rt-2', 'rt-3', 'rt-4'])
		expect(installation.revoked).toBe(false)
		expect(store.stored).toBe('rt-5')
	})

	test('without the lock the same two processes replay a refresh token and lose the grant', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper(installation.grant())
		const one = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper))
		const two = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper))
		const results = await Promise.allSettled([one(RPC), two(RPC)])
		expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
		expect(installation.revoked).toBe(true)
	})

	test('a crash between IAM rotating the token and the helper storing it spends the grant, and says so', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper(installation.grant())
		store.failNextStores()
		await expect(controlOAuthBearer(CONSOLE, dependencies(installation, store.helper))(RPC)).rejects.toThrow(
			'IAM rotated the refresh token, but storing the new one failed (helper store exited with 1); the stored one is spent',
		)
		const next = controlOAuthBearer(CONSOLE, dependencies(installation, memoryHelper(store.stored).helper))
		await expect(next(RPC)).rejects.toThrow('expired, was revoked, or its refresh token was used twice; run `fabrika control auth device` again')
	})

	test('a resource the grant does not cover is refused with what to do, and the grant still works', async () => {
		const installation = fakeInstallation({ covers: [RPC] })
		const store = memoryHelper(installation.grant())
		const bearer = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper))
		await expect(bearer(OPERATIONS_RPC)).rejects.toThrow(`does not cover ${OPERATIONS_RPC}; approve a preset that does`)
		expect(await bearer(RPC)).toContain(RPC)
		expect(installation.revoked).toBe(false)
	})

	test('an answer it cannot read still has its rotated refresh token stored', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper('rt-old')
		const odd: RpcFetch = (input, init) =>
			String(input) === `${IAM}/oauth/token`
				? Promise.resolve(Response.json({ access_token: 'at', token_type: 'mac', expires_in: 300, refresh_token: 'rt-rotated' }))
				: installation.fetch(input, init)
		await expect(controlOAuthBearer(CONSOLE, dependencies(installation, store.helper, { fetch: odd }))(RPC)).rejects.toThrow(
			'in a shape this CLI cannot read',
		)
		expect(store.stored).toBe('rt-rotated')
	})

	test('a refresh whose answer is lost is not sent again', async () => {
		const installation = fakeInstallation()
		const store = memoryHelper(installation.grant())
		let attempts = 0
		const lost: RpcFetch = (input, init) => {
			if (String(input) !== `${IAM}/oauth/token`) return installation.fetch(input, init)
			attempts++
			return Promise.reject(new TypeError('socket closed'))
		}
		const bearer = controlOAuthBearer(CONSOLE, dependencies(installation, store.helper, { fetch: lost }))
		await expect(bearer(RPC)).rejects.toThrow('did not answer the refresh. If it arrived there, the stored refresh token is spent')
		expect(attempts).toBe(1)
		expect(store.stored).toBe('rt-1')
	})
})

describe('the Control transport', () => {
	const env = { FABRIKA_CONTROL_URL: CONSOLE, FABRIKA_CONTROL_CREDENTIAL_HELPER: 'unused' }

	test("carries each resource's own access token, and the key instead when both are set", async () => {
		const installation = fakeInstallation()
		const sent: string[] = []
		const send: RpcFetch = (input, init) => {
			sent.push(`${String(input)} ${new Headers(init?.headers).get('authorization')}`)
			return Promise.resolve(Response.json({ result: null }))
		}
		const deps = dependencies(installation, memoryHelper(installation.grant()).helper)
		const transport = controlTransport(undefined, env, send, deps)
		await transport.fetch(RPC, { method: 'POST' })
		await transport.fetch(OPERATIONS_RPC, { method: 'POST' })
		expect(sent).toEqual([`${RPC} Bearer at-2:${RPC}`, `${OPERATIONS_RPC} Bearer at-3:${OPERATIONS_RPC}`])
		const elsewhere = await transport.fetch('https://elsewhere.test/api/rpc', { method: 'POST' })
		expect(elsewhere.status).toBe(401)
		expect(await elsewhere.text()).toContain(`sent to ${CONSOLE} only`)
		expect(sent).toHaveLength(2)

		const keyed = controlTransport(undefined, { ...env, FABRIKA_CONTROL_KEY: 'px_key' }, send, deps)
		await keyed.fetch(RPC, { method: 'POST' })
		expect(sent.at(-1)).toBe(`${RPC} Bearer px_key`)
		expect(installation.tokenCalls).toHaveLength(2)
	})

	test("a grant's failure reaches the caller of the RPC client with its reason, not as a network error", async () => {
		const installation = fakeInstallation()
		const client = connectControl(undefined, env, dependencies(installation, memoryHelper(null).helper))
		const failure = await client.consoleAccess().then(() => null, (error: unknown) => error)
		if (!(failure instanceof RpcError)) throw new Error('expected an RpcError')
		expect([failure.type, failure.httpStatus]).toEqual(['credential', 401])
		expect(failure.message).toBe(`FABRIKA_CONTROL_CREDENTIAL_HELPER holds no grant for ${CONSOLE}; run \`fabrika control auth device\` first`)
	})

	test('needs one of the two credentials', () => {
		expect(() => controlTransport(undefined, { FABRIKA_CONTROL_URL: CONSOLE })).toThrow(MISSING_CONTROL_CREDENTIAL)
	})

	test('drops an answer that echoes the access token', async () => {
		const installation = fakeInstallation()
		const deps = dependencies(installation, memoryHelper(installation.grant()).helper)
		const echo: RpcFetch = (_input, init) => Promise.resolve(Response.json({ result: new Headers(init?.headers).get('authorization') }))
		const response = await controlTransport(undefined, env, echo, deps).fetch(RPC, { method: 'POST' })
		expect(response.status).toBe(502)
		expect(await response.text()).not.toContain('at-')
	})
})

describe('the credential helper and the lock', () => {
	test('runs the command with the action as its argument and the origin and token on stdin', async () => {
		const directory = await scratch()
		const script = join(directory, 'helper.sh')
		await writeFile(
			script,
			[
				'#!/bin/sh',
				`if [ "$1" = get ]; then cat > "${directory}/get.in"; [ -f "${directory}/token" ] && echo "refresh_token=$(cat "${directory}/token")"; exit 0; fi`,
				`if [ "$1" = store ]; then cat > "${directory}/store.in"; sed -n 's/^refresh_token=//p' "${directory}/store.in" > "${directory}/token"; exit 0; fi`,
				'exit 7',
			].join('\n'),
			{ mode: 0o700 },
		)
		const helper = commandCredentialHelper(script)
		expect(await helper.get(CONSOLE)).toBeNull()
		expect(await readFile(join(directory, 'get.in'), 'utf8')).toBe(`origin=${CONSOLE}\n`)
		await helper.store(CONSOLE, 'rt-secret')
		expect(await readFile(join(directory, 'store.in'), 'utf8')).toBe(`origin=${CONSOLE}\nrefresh_token=rt-secret\n`)
		expect(await helper.get(CONSOLE)).toBe('rt-secret')
		await expect(commandCredentialHelper(`${script} unknown`).get(CONSOLE)).rejects.toThrow('FABRIKA_CONTROL_CREDENTIAL_HELPER get exited with 7')
	})

	test("waiters that find a crashed holder's lock at once let exactly one of them hold it at a time", async () => {
		const directory = await scratch()
		const crashed = Bun.spawn(['true'])
		await crashed.exited
		const lock = fileCredentialLock(directory, 5_000)
		let holding = 0
		let most = 0
		for (let round = 0; round < 20; round++) {
			const release = await lock(CONSOLE)
			const [file] = await Array.fromAsync(new Bun.Glob('*.lock').scan(directory))
			if (file === undefined) throw new Error('expected a lock file')
			await writeFile(join(directory, file), `${crashed.pid} left-behind\n`)
			await release()
			await Promise.all(
				Array.from({ length: 3 }, async () => {
					const held = await lock(CONSOLE)
					holding++
					most = Math.max(most, holding)
					await Bun.sleep(2)
					holding--
					await held()
				}),
			)
		}
		expect(most).toBe(1)
	}, 20_000)

	test("leaves a crashed holder's lock to the process taking it over, and clears a guard its crash left behind", async () => {
		const directory = await scratch()
		const lock = fileCredentialLock(directory, 5_000)
		await (await lock(CONSOLE))()
		const crashed = Bun.spawn(['true'])
		await crashed.exited
		const file = join(directory, `${createHash('sha256').update(CONSOLE).digest('hex').slice(0, 32)}.lock`)
		const guard = `${file}.takeover`
		await writeFile(file, `${crashed.pid} left-behind\n`)
		await writeFile(guard, '')
		const waiting = lock(CONSOLE)
		await Bun.sleep(200)
		expect(await readFile(file, 'utf8')).toBe(`${crashed.pid} left-behind\n`)
		await unlink(guard)
		await (await waiting)()

		await writeFile(file, `${crashed.pid} left-behind\n`)
		await writeFile(guard, '')
		const abandoned = new Date(Date.now() - 60_000)
		await utimes(guard, abandoned, abandoned)
		const taken = await lock(CONSOLE)
		expect((await readFile(file, 'utf8')).split(' ')[0]).toBe(String(process.pid))
		await taken()
	})

	test("takes over a crashed holder's lock and waits for a live one", async () => {
		const directory = await scratch()
		const lock = fileCredentialLock(directory, 200)
		const release = await lock(CONSOLE)
		await expect(lock(CONSOLE)).rejects.toThrow('Another fabrika process holds')
		await release()
		const crashed = Bun.spawn(['true'])
		await crashed.exited
		const held = await lock(CONSOLE)
		const [file] = (await Array.fromAsync(new Bun.Glob('*.lock').scan(directory))).map((name) => join(directory, name))
		await held()
		if (file === undefined) throw new Error('expected a lock file')
		await writeFile(file, `${crashed.pid} left-behind\n`)
		const taken = await lock(CONSOLE)
		expect((await readFile(file, 'utf8')).split(' ')[0]).toBe(String(process.pid))
		await taken()
	})
})
