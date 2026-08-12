import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { GitHubAppClient, type GitHubAppClientConfig, type GitHubAppFetch, pemToPkcs8 } from '..'

const NOW = Date.UTC(2026, 7, 11, 10, 20, 30)
const EXPIRES_AT = '2026-08-11T11:20:30.000Z'
const SECRET_TOKEN = 'ghs_private-installation-token'
const SECRET_BODY = 'upstream-secret-response-body'
const WEBHOOK_URL = 'https://control.example.test/webhooks/github'
const WEBHOOK_SECRET = 'private-webhook-secret'

const keyPair = (format: 'pkcs1' | 'pkcs8'): string => {
	const { privateKey } = generateKeyPairSync('rsa', {
		modulusLength: 2048,
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: format, format: 'pem' },
	})
	return privateKey
}

const PKCS1_KEY = keyPair('pkcs1')
const PKCS8_KEY = keyPair('pkcs8')

const installation = (id: number, login = 'contember', type: 'Organization' | 'User' = 'Organization'): Record<string, unknown> => ({
	id,
	app_id: 123456,
	target_type: type,
	account: { login, type },
})

const appIdentity = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
	id: 123456,
	slug: 'fabrika-test',
	html_url: 'https://github.com/apps/fabrika-test',
	owner: { login: 'contember', type: 'Organization' },
	...overrides,
})

const webhookConfig = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
	url: WEBHOOK_URL,
	content_type: 'json',
	insecure_ssl: '0',
	secret: '********',
	...overrides,
})

interface CapturedRequest {
	url: string
	init: RequestInit | undefined
}

function capturingFetch(responses: Response[]): { fetch: GitHubAppFetch; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = []
	let index = 0
	return {
		requests,
		fetch: (input, init) => {
			requests.push({ url: input.toString(), init })
			const response = responses[index]
			index += 1
			return response === undefined ? Promise.reject(new Error('unexpected test request')) : Promise.resolve(response)
		},
	}
}

function requestAt(requests: CapturedRequest[], index: number): CapturedRequest {
	const request = requests[index]
	if (request === undefined) throw new Error(`missing captured request ${index}`)
	return request
}

function decodeJwtSegment(jwt: string, index: number): unknown {
	const segment = jwt.split('.')[index]
	if (segment === undefined) throw new Error('missing JWT segment')
	const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
	const decoded: unknown = JSON.parse(atob(padded))
	return decoded
}

function field(value: unknown, name: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined
}

function config(fetchImplementation: GitHubAppFetch, privateKeyPem = PKCS8_KEY): GitHubAppClientConfig {
	return {
		appId: '123456',
		privateKeyPem,
		apiBaseUrl: 'https://github.example/api/v3/',
		fetch: fetchImplementation,
		now: () => NOW,
	}
}

async function client(fetchImplementation: GitHubAppFetch, privateKeyPem = PKCS8_KEY): Promise<GitHubAppClient> {
	return GitHubAppClient.create(config(fetchImplementation, privateKeyPem))
}

const tokenInput = (signal?: AbortSignal) => ({
	installationId: 77,
	owner: 'contember',
	repository: 'fabrika',
	...(signal === undefined ? {} : { signal }),
})

async function errorOf(operation: Promise<unknown>): Promise<Error> {
	try {
		await operation
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error))
	}
	throw new Error('expected operation to fail')
}

describe('GitHubAppClient boot and JWT', () => {
	test('imports and caches both GitHub PKCS1 and PKCS8 keys at async boot', async () => {
		for (const privateKeyPem of [PKCS1_KEY, PKCS8_KEY]) {
			const capture = capturingFetch([Response.json(installation(42))])
			const github = await client(capture.fetch, privateKeyPem)
			expect(await github.resolveInstallationId('contember', 'fabrika')).toBe(42)
		}
		const importsAndSigns = async (pem: string): Promise<boolean> => {
			const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'])
			return (await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode('fabrika'))).byteLength > 0
		}
		expect(await importsAndSigns(PKCS1_KEY)).toBe(true)
		expect(await importsAndSigns(PKCS8_KEY)).toBe(true)
	})

	test('fails boot on syntactically valid PEM with invalid DER', async () => {
		const invalidDerPem = '-----BEGIN PRIVATE KEY-----\nMAA=\n-----END PRIVATE KEY-----'
		await expect(GitHubAppClient.create({ appId: '1', privateKeyPem: invalidDerPem })).rejects.toThrow('GitHub App configuration is invalid')
	})

	test('signs bounded RS256 App JWT claims using the injected clock', async () => {
		const capture = capturingFetch([Response.json(installation(42))])
		expect(await (await client(capture.fetch)).resolveInstallationId('contember', 'fabrika')).toBe(42)
		const authorization = new Headers(requestAt(capture.requests, 0).init?.headers).get('authorization')
		const jwt = authorization?.slice('Bearer '.length) ?? ''
		const header = decodeJwtSegment(jwt, 0)
		const payload = decodeJwtSegment(jwt, 1)
		expect(field(header, 'alg')).toBe('RS256')
		expect(field(header, 'typ')).toBe('JWT')
		expect(field(payload, 'iss')).toBe('123456')
		expect(field(payload, 'iat')).toBe(Math.floor(NOW / 1000) - 30)
		expect(field(payload, 'exp')).toBe(Math.floor(NOW / 1000) + 9 * 60)
	})
})

describe('GitHubAppClient requests', () => {
	test('uses exact lookup path and a repository-scoped read-only token request', async () => {
		const capture = capturingFetch([
			Response.json(installation(77)),
			Response.json({ token: SECRET_TOKEN, expires_at: EXPIRES_AT }),
		])
		const github = await client(capture.fetch)
		expect(await github.resolveInstallationId('contember', '.github')).toBe(77)
		expect(await github.mintRepositoryToken(tokenInput())).toEqual({ token: SECRET_TOKEN, expiresAt: Date.parse(EXPIRES_AT) })

		const lookup = requestAt(capture.requests, 0)
		const mint = requestAt(capture.requests, 1)
		expect(lookup.url).toBe('https://github.example/api/v3/repos/contember/.github/installation')
		expect(mint.url).toBe('https://github.example/api/v3/app/installations/77/access_tokens')
		expect(mint.init?.method).toBe('POST')
		expect(mint.init?.body).toBe(JSON.stringify({ repositories: ['fabrika'], permissions: { contents: 'read' } }))
		for (const request of [lookup, mint]) {
			const headers = new Headers(request.init?.headers)
			expect(headers.get('authorization')).toStartWith('Bearer ')
			expect(headers.get('accept')).toBe('application/vnd.github+json')
			expect(headers.get('x-github-api-version')).toBe('2022-11-28')
			expect(headers.get('user-agent')).toBe('vozka')
			expect(request.init?.redirect).toBe('error')
			expect(request.init?.signal).toBeInstanceOf(AbortSignal)
		}
		expect(new Headers(mint.init?.headers).get('content-type')).toBe('application/json')
	})

	test('treats a repository installation 404 as a lookup miss', async () => {
		const capture = capturingFetch([new Response(SECRET_BODY, { status: 404 })])
		expect(await (await client(capture.fetch)).resolveInstallationId('contember', 'missing')).toBeNull()
	})

	test('parses valid tokens and rejects malformed token responses', async () => {
		for (
			const body of [
				{ expires_at: EXPIRES_AT },
				{ token: '', expires_at: EXPIRES_AT },
				{ token: 'invalid token', expires_at: EXPIRES_AT },
				{ token: SECRET_TOKEN, expires_at: 'invalid' },
				{ token: SECRET_TOKEN, expires_at: '2026-08-11T09:20:30.000Z' },
			]
		) {
			const malformed = capturingFetch([Response.json(body)])
			await expect((await client(malformed.fetch)).mintRepositoryToken(tokenInput())).rejects.toThrow('GitHub App response is invalid')
		}
	})

	test('rejects success bodies above 64 KiB without exposing them', async () => {
		const oversized = JSON.stringify({ token: SECRET_BODY.repeat(8_000), expires_at: EXPIRES_AT })
		const capture = capturingFetch([new Response(oversized, { status: 200 })])
		const error = await errorOf((await client(capture.fetch)).mintRepositoryToken(tokenInput()))
		expect(error.message).toBe('GitHub App response is invalid')
		expect(error.message).not.toContain(SECRET_BODY)
	})
})

describe('GitHubAppClient operator verification', () => {
	test('reads and binds the authenticated App identity with the exact App-JWT request', async () => {
		const capture = capturingFetch([Response.json(appIdentity())])
		const github = await client(capture.fetch)
		expect(await github.getAuthenticatedApp()).toEqual({
			id: 123456,
			slug: 'fabrika-test',
			htmlUrl: 'https://github.com/apps/fabrika-test',
			owner: { login: 'contember', type: 'Organization' },
		})
		const request = requestAt(capture.requests, 0)
		expect(request.url).toBe('https://github.example/api/v3/app')
		expect(request.init?.method).toBeUndefined()
		expect(new Headers(request.init?.headers).get('authorization')).toStartWith('Bearer ')
		expect(request.init?.redirect).toBe('error')
	})

	test('reads webhook config without returning its masked secret', async () => {
		const capture = capturingFetch([Response.json(webhookConfig())])
		const github = await client(capture.fetch)
		const config = await github.getWebhookConfig()
		expect(config).toEqual({ url: WEBHOOK_URL, contentType: 'json', insecureSsl: '0' })
		expect(requestAt(capture.requests, 0).url).toBe('https://github.example/api/v3/app/hook/config')
		expect(JSON.stringify(config)).not.toContain('********')
	})

	test('updates webhook config with an exact secure body and binds the response', async () => {
		const capture = capturingFetch([Response.json(webhookConfig())])
		const github = await client(capture.fetch)
		expect(await github.updateWebhookConfig({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET })).toEqual({
			url: WEBHOOK_URL,
			contentType: 'json',
			insecureSsl: '0',
		})
		const request = requestAt(capture.requests, 0)
		expect(request.url).toBe('https://github.example/api/v3/app/hook/config')
		expect(request.init?.method).toBe('PATCH')
		expect(request.init?.body).toBe(JSON.stringify({
			url: WEBHOOK_URL,
			content_type: 'json',
			insecure_ssl: '0',
			secret: WEBHOOK_SECRET,
		}))
		expect(new Headers(request.init?.headers).get('content-type')).toBe('application/json')
	})

	test('verifies organization and repository installations without modifying repository access', async () => {
		const capture = capturingFetch([
			Response.json(installation(71, 'Contember')),
			Response.json(installation(72, 'Contember', 'User')),
		])
		const github = await client(capture.fetch)
		expect(await github.resolveOrganizationInstallationId('contember')).toBe(71)
		expect(await github.resolveInstallationId('contember', 'fabrika')).toBe(72)
		expect(capture.requests.map((request) => request.url)).toEqual([
			'https://github.example/api/v3/orgs/contember/installation',
			'https://github.example/api/v3/repos/contember/fabrika/installation',
		])
		for (const request of capture.requests) expect(request.init?.method).toBeUndefined()
	})

	test('rejects repository installations bound to another App, owner, or account type', async () => {
		const responses = [
			Response.json({ ...installation(72), app_id: 999 }),
			Response.json(installation(72, 'attacker')),
			Response.json({ ...installation(72), target_type: 'User' }),
			Response.json({ ...installation(72), account: { login: 'contember', type: 'User' } }),
		]
		for (const response of responses) {
			const github = await client(capturingFetch([response]).fetch)
			await expect(github.resolveInstallationId('contember', 'fabrika')).rejects.toThrow('GitHub App response is invalid')
		}
	})

	test('treats organization installation 404 as a miss', async () => {
		const capture = capturingFetch([new Response(SECRET_BODY, { status: 404 })])
		expect(await (await client(capture.fetch)).resolveOrganizationInstallationId('contember')).toBeNull()
	})

	test('rejects identities, webhook updates, and installations that are not bound to the request', async () => {
		const cases: Array<(github: GitHubAppClient) => Promise<unknown>> = [
			(github) => github.getAuthenticatedApp(),
			(github) => github.updateWebhookConfig({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET }),
			(github) => github.resolveOrganizationInstallationId('contember'),
			(github) => github.resolveInstallationId('contember', 'fabrika'),
		]
		const responses: Response[] = [
			Response.json(appIdentity({ id: 999 })),
			Response.json(webhookConfig({ url: 'https://attacker.example/hook' })),
			Response.json(installation(71, 'attacker')),
			Response.json({ ...installation(72), id: 'not-an-id' }),
		]
		const operations = cases[Symbol.iterator]()
		for (const response of responses) {
			const operation = operations.next().value
			if (operation === undefined) throw new Error('missing verification case')
			await expect(operation(await client(capturingFetch([response]).fetch))).rejects.toThrow('GitHub App response is invalid')
		}
	})
})

describe('GitHubAppClient cancellation', () => {
	test('returns a sanitized AbortError for a pre-aborted caller signal', async () => {
		let requests = 0
		const fetchImplementation: GitHubAppFetch = () => {
			requests += 1
			return Promise.reject(new Error('must not run'))
		}
		const controller = new AbortController()
		controller.abort(`secret-reason-${SECRET_TOKEN}`)
		const error = await errorOf((await client(fetchImplementation)).mintRepositoryToken(tokenInput(controller.signal)))
		expect(error.name).toBe('AbortError')
		expect(error.message).toBe('GitHub App request was aborted')
		expect(error.message).not.toContain(SECRET_TOKEN)
		expect(requests).toBe(0)
	})

	test('propagates in-flight caller abort through the fetch signal as a sanitized AbortError', async () => {
		let requestStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => requestStarted = resolve)
		const fetchImplementation: GitHubAppFetch = (_input, init) =>
			new Promise((_resolve, reject) => {
				requestStarted?.()
				init?.signal?.addEventListener('abort', () => reject(new Error(`fetch leaked ${SECRET_TOKEN}`)), { once: true })
			})
		const controller = new AbortController()
		const operation = (await client(fetchImplementation)).mintRepositoryToken(tokenInput(controller.signal))
		await started
		controller.abort(`caller leaked ${SECRET_TOKEN}`)
		const error = await errorOf(operation)
		expect(error.name).toBe('AbortError')
		expect(error.message).toBe('GitHub App request was aborted')
	})

	test('propagates abort while reading a success body', async () => {
		let bodyStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => bodyStarted = resolve)
		const stream = new ReadableStream<Uint8Array>({
			start() {
				bodyStarted?.()
			},
		})
		const controller = new AbortController()
		const operation = (await client(() => Promise.resolve(new Response(stream)))).mintRepositoryToken(tokenInput(controller.signal))
		await started
		controller.abort(`body leaked ${SECRET_TOKEN}`)
		const error = await errorOf(operation)
		expect(error.name).toBe('AbortError')
		expect(error.message).toBe('GitHub App request was aborted')
	})

	test('enforces a sanitized bounded internal timeout', async () => {
		const fetchImplementation: GitHubAppFetch = (_input, init) =>
			new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error(SECRET_TOKEN)), { once: true }))
		const github = await GitHubAppClient.create({ ...config(fetchImplementation), timeoutMs: 5 })
		const error = await errorOf(github.resolveInstallationId('contember', 'fabrika'))
		expect(error.name).toBe('TimeoutError')
		expect(error.message).toBe('GitHub App request timed out')
	})

	test('applies caller cancellation and the body deadline to operator methods', async () => {
		const controller = new AbortController()
		controller.abort(`operator leaked ${WEBHOOK_SECRET}`)
		let requests = 0
		const preAborted = await client(() => {
			requests++
			return Promise.reject(new Error('must not run'))
		})
		const aborted = await errorOf(preAborted.getAuthenticatedApp(controller.signal))
		expect(aborted.name).toBe('AbortError')
		expect(aborted.message).not.toContain(WEBHOOK_SECRET)
		expect(requests).toBe(0)

		const hangingBody = new ReadableStream<Uint8Array>({
			start(bodyController) {
				bodyController.enqueue(new TextEncoder().encode('{'))
			},
		})
		const timed = await GitHubAppClient.create({ ...config(() => Promise.resolve(new Response(hangingBody))), timeoutMs: 5 })
		const timeout = await errorOf(timed.getWebhookConfig())
		expect(timeout.name).toBe('TimeoutError')
		expect(timeout.message).toBe('GitHub App request timed out')
	})
})

describe('GitHubAppClient validation and redaction', () => {
	test('validates config, repository coordinates, installation ids, and timeout', async () => {
		const noRequest: GitHubAppFetch = () => Promise.reject(new Error('must not run'))
		for (const appId of ['', '0', '-1', 'app-1', ' 1']) {
			await expect(GitHubAppClient.create({ appId, privateKeyPem: PKCS8_KEY, fetch: noRequest })).rejects.toThrow('GitHub App configuration is invalid')
		}
		for (const apiBaseUrl of ['http://api.github.test', 'https://user:secret@api.github.test', 'https://api.github.test?token=secret']) {
			await expect(GitHubAppClient.create({ appId: '1', privateKeyPem: PKCS8_KEY, apiBaseUrl, fetch: noRequest })).rejects.toThrow(
				'GitHub App configuration is invalid',
			)
		}
		await expect(GitHubAppClient.create({ appId: '1', privateKeyPem: PKCS8_KEY, fetch: noRequest, timeoutMs: 0 })).rejects.toThrow(
			'GitHub App configuration is invalid',
		)
		const github = await GitHubAppClient.create({ appId: '1', privateKeyPem: PKCS8_KEY, fetch: noRequest })
		await expect(github.resolveInstallationId('../owner', 'repo')).rejects.toThrow('GitHub App configuration is invalid')
		await expect(github.mintRepositoryToken({ installationId: 0, owner: 'owner', repository: 'repo' })).rejects.toThrow(
			'GitHub App configuration is invalid',
		)
		await expect(github.resolveOrganizationInstallationId('../org')).rejects.toThrow('GitHub App configuration is invalid')
		for (const url of ['http://control.example.test/hook', 'https://user:secret@control.example.test/hook', 'https://control.example.test/hook?q=1']) {
			await expect(github.updateWebhookConfig({ url, secret: WEBHOOK_SECRET })).rejects.toThrow('GitHub App configuration is invalid')
		}
		await expect(github.updateWebhookConfig({ url: WEBHOOK_URL, secret: '' })).rejects.toThrow('GitHub App configuration is invalid')
	})

	test('redacts status, malformed body, network URL, JWT, token, and PEM details', async () => {
		const statusCapture = capturingFetch([new Response(`${SECRET_BODY} ${SECRET_TOKEN}`, { status: 500 })])
		const statusError = await errorOf((await client(statusCapture.fetch)).mintRepositoryToken(tokenInput()))
		const request = requestAt(statusCapture.requests, 0)
		const jwt = new Headers(request.init?.headers).get('authorization') ?? ''
		for (const secret of [SECRET_BODY, SECRET_TOKEN, PKCS8_KEY, jwt, request.url]) expect(statusError.message).not.toContain(secret)
		expect(statusError.message).toBe('GitHub App request failed with status 500')

		const throwingFetch: GitHubAppFetch = () => Promise.reject(new Error(`https://private.example/${SECRET_TOKEN}`))
		const networkError = await errorOf((await client(throwingFetch)).resolveInstallationId('owner', 'repo'))
		expect(networkError.message).toBe('GitHub App request failed')
		expect(networkError.message).not.toContain(SECRET_TOKEN)

		const malformed = capturingFetch([new Response(`${SECRET_BODY} ${SECRET_TOKEN}`, { status: 200 })])
		const malformedError = await errorOf((await client(malformed.fetch)).mintRepositoryToken(tokenInput()))
		expect(malformedError.message).toBe('GitHub App response is invalid')

		const webhookStatus = capturingFetch([new Response(`${SECRET_BODY} ${WEBHOOK_SECRET}`, { status: 422 })])
		const webhookError = await errorOf((await client(webhookStatus.fetch)).updateWebhookConfig({ url: WEBHOOK_URL, secret: WEBHOOK_SECRET }))
		expect(webhookError.message).toBe('GitHub App request failed with status 422')
		for (const secret of [SECRET_BODY, WEBHOOK_SECRET, requestAt(webhookStatus.requests, 0).url]) {
			expect(webhookError.message).not.toContain(secret)
		}
	})
})
