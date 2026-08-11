export interface GitHubAppClientConfig {
	/** Numeric GitHub App id, kept as a string because it is the JWT issuer. */
	appId: string
	/** GitHub App RSA private key in PKCS1 or PKCS8 PEM form. */
	privateKeyPem: string
	/** GitHub API base URL. Defaults to the public GitHub API. */
	apiBaseUrl?: string
	/** HTTP implementation for the current runtime. */
	fetch?: GitHubAppFetch
	/** Millisecond Unix clock. */
	now?: () => number
	/** Upper bound for each GitHub API request, including its response body. */
	timeoutMs?: number
}

export interface GitHubInstallationToken {
	token: string
	expiresAt: number
}

export interface GitHubRepositoryTokenRequest {
	installationId: number
	owner: string
	repository: string
	signal?: AbortSignal
}

export type GitHubAppFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 64 * 1024
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'vozka'
const APP_ID_PATTERN = /^[1-9][0-9]*$/
const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/
const NOT_FOUND = Symbol('not-found')

/** GitHub App machine identity. Webhook authentication belongs to the receiving service. */
export class GitHubAppClient {
	private constructor(
		private readonly appId: string,
		private readonly privateKey: CryptoKey,
		private readonly apiBaseUrl: string,
		private readonly fetchImplementation: GitHubAppFetch,
		private readonly clock: () => number,
		private readonly timeoutMs: number,
	) {}

	/** Validate all configuration and import the RSA key before a credential-owning service boots. */
	static async create(config: GitHubAppClientConfig): Promise<GitHubAppClient> {
		if (!APP_ID_PATTERN.test(config.appId) || config.appId.length > 32) {
			throw configurationError()
		}
		const apiBaseUrl = normalizeApiBaseUrl(config.apiBaseUrl ?? DEFAULT_API_BASE_URL)
		const timeoutMs = config.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_REQUEST_TIMEOUT_MS) {
			throw configurationError()
		}
		let privateKey: CryptoKey
		try {
			privateKey = await crypto.subtle.importKey(
				'pkcs8',
				pemToPkcs8(config.privateKeyPem),
				{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
				false,
				['sign'],
			)
		} catch {
			throw configurationError()
		}
		return new GitHubAppClient(config.appId, privateKey, apiBaseUrl, config.fetch ?? fetch, config.now ?? Date.now, timeoutMs)
	}

	/** Resolve the App installation for one GitHub repository. A 404 is an expected miss. */
	async resolveInstallationId(owner: string, repository: string, signal?: AbortSignal): Promise<number | null> {
		validateRepositoryComponent(owner)
		validateRepositoryComponent(repository)
		const body = await this.requestJson(`/repos/${owner}/${repository}/installation`, {}, signal, true)
		if (body === NOT_FOUND) {
			return null
		}
		const id = objectField(body, 'id')
		if (typeof id !== 'number' || !isPositiveSafeInteger(id)) {
			throw responseError()
		}
		return id
	}

	/** Mint a read-only token restricted to one repository in the selected installation. */
	async mintRepositoryToken(input: GitHubRepositoryTokenRequest): Promise<GitHubInstallationToken> {
		if (!isPositiveSafeInteger(input.installationId)) {
			throw configurationError()
		}
		validateRepositoryComponent(input.owner)
		validateRepositoryComponent(input.repository)
		const body = await this.requestJson(
			`/app/installations/${input.installationId}/access_tokens`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ repositories: [input.repository], permissions: { contents: 'read' } }),
			},
			input.signal,
			false,
		)
		if (body === NOT_FOUND) {
			throw responseError()
		}
		const token = objectField(body, 'token')
		const expiresAtValue = objectField(body, 'expires_at')
		const expiresAt = typeof expiresAtValue === 'string' ? Date.parse(expiresAtValue) : Number.NaN
		if (
			typeof token !== 'string' || token.length === 0 || token.length > 4096 || /\s/.test(token) || !Number.isFinite(expiresAt)
			|| expiresAt <= this.now()
		) {
			throw responseError()
		}
		return { token, expiresAt }
	}

	private async requestJson(
		path: string,
		init: RequestInit,
		callerSignal: AbortSignal | undefined,
		allowNotFound: boolean,
	): Promise<unknown | typeof NOT_FOUND> {
		const cancellation = createCancellation(callerSignal, this.timeoutMs)
		try {
			cancellation.throwIfCancelled()
			let jwt: string
			try {
				jwt = await this.signAppJwt()
			} catch (error) {
				cancellation.throwIfCancelled()
				throw error
			}
			cancellation.throwIfCancelled()
			const headers = new Headers(init.headers)
			headers.set('authorization', `Bearer ${jwt}`)
			headers.set('accept', GITHUB_ACCEPT)
			headers.set('x-github-api-version', GITHUB_API_VERSION)
			headers.set('user-agent', GITHUB_USER_AGENT)
			let response: Response
			try {
				response = await this.fetchImplementation(`${this.apiBaseUrl}${path}`, {
					...init,
					headers,
					redirect: 'error',
					signal: cancellation.signal,
				})
			} catch {
				cancellation.throwIfCancelled()
				throw new Error('GitHub App request failed')
			}
			cancellation.throwIfCancelled()
			if (allowNotFound && response.status === 404) {
				return NOT_FOUND
			}
			if (!response.ok) {
				throw requestStatusError(response.status)
			}
			return await readBoundedJson(response, cancellation)
		} finally {
			cancellation.dispose()
		}
	}

	private async signAppJwt(): Promise<string> {
		const now = Math.floor(this.now() / 1000)
		const header = { alg: 'RS256', typ: 'JWT' }
		const payload = { iat: now - 30, exp: now + 9 * 60, iss: this.appId }
		const encode = (value: unknown): string => base64url(utf8(JSON.stringify(value)))
		const signingInput = `${encode(header)}.${encode(payload)}`
		try {
			const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', this.privateKey, utf8(signingInput))
			return `${signingInput}.${base64url(new Uint8Array(signature))}`
		} catch {
			throw configurationError()
		}
	}

	private now(): number {
		let value: number
		try {
			value = this.clock()
		} catch {
			throw configurationError()
		}
		if (!Number.isFinite(value)) {
			throw configurationError()
		}
		return value
	}
}

interface RequestCancellation {
	readonly signal: AbortSignal
	throwIfCancelled(): void
	dispose(): void
}

function createCancellation(callerSignal: AbortSignal | undefined, timeoutMs: number): RequestCancellation {
	const controller = new AbortController()
	let timedOut = false
	const abortFromCaller = (): void => controller.abort()
	if (callerSignal?.aborted === true) {
		controller.abort()
	} else {
		callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
	}
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	return {
		signal: controller.signal,
		throwIfCancelled() {
			if (callerSignal?.aborted === true) {
				throw abortError()
			}
			if (timedOut) {
				throw timeoutError()
			}
			if (controller.signal.aborted) {
				throw abortError()
			}
		},
		dispose() {
			clearTimeout(timer)
			callerSignal?.removeEventListener('abort', abortFromCaller)
		},
	}
}

async function readBoundedJson(response: Response, cancellation: RequestCancellation): Promise<unknown> {
	cancellation.throwIfCancelled()
	const contentLength = response.headers.get('content-length')
	if (contentLength !== null && /^[0-9]+$/.test(contentLength) && Number(contentLength) > MAX_RESPONSE_BYTES) {
		throw responseError()
	}
	const reader = response.body?.getReader()
	if (reader === undefined) {
		throw responseError()
	}
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readChunk(reader, cancellation)
			if (result.done) {
				break
			}
			total += result.value.byteLength
			if (total > MAX_RESPONSE_BYTES) {
				throw responseError()
			}
			chunks.push(result.value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
		cancellation.throwIfCancelled()
		throw error
	} finally {
		reader.releaseLock()
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	cancellation.throwIfCancelled()
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		const body: unknown = JSON.parse(text)
		cancellation.throwIfCancelled()
		return body
	} catch (error) {
		cancellation.throwIfCancelled()
		if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
			throw error
		}
		throw responseError()
	}
}

function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cancellation: RequestCancellation,
): Promise<{ done: true } | { done: false; value: Uint8Array }> {
	cancellation.throwIfCancelled()
	return new Promise((resolve, reject) => {
		const aborted = (): void => {
			cleanup()
			try {
				cancellation.throwIfCancelled()
			} catch (error) {
				reject(error)
			}
		}
		const cleanup = (): void => cancellation.signal.removeEventListener('abort', aborted)
		cancellation.signal.addEventListener('abort', aborted, { once: true })
		reader.read().then(
			(result) => {
				cleanup()
				resolve(result.done ? { done: true } : { done: false, value: result.value })
			},
			() => {
				cleanup()
				try {
					cancellation.throwIfCancelled()
					reject(responseError())
				} catch (error) {
					reject(error)
				}
			},
		)
	})
}

/** Convert a GitHub App PKCS1 or PKCS8 PEM key into PKCS8 DER for WebCrypto. */
export function pemToPkcs8(pem: string): Uint8Array<ArrayBuffer> {
	const pkcs1 = /^-----BEGIN RSA PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END RSA PRIVATE KEY-----\s*$/.exec(pem)
	const pkcs8 = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/.exec(pem)
	const match = pkcs1 ?? pkcs8
	const body = match?.[1]
	if (body === undefined) {
		throw configurationError()
	}
	let binary: string
	try {
		binary = atob(body.replace(/\s+/g, ''))
	} catch {
		throw configurationError()
	}
	if (binary.length === 0 || binary.charCodeAt(0) !== 0x30) {
		throw configurationError()
	}
	const der = new Uint8Array(binary.length)
	for (let index = 0; index < binary.length; index++) {
		der[index] = binary.charCodeAt(index)
	}
	return pkcs1 === null ? der : wrapPkcs1AsPkcs8(der)
}

function normalizeApiBaseUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw configurationError()
	}
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
		throw configurationError()
	}
	return url.toString().replace(/\/$/, '')
}

function validateRepositoryComponent(value: string): void {
	if (value.length === 0 || value.length > 100 || !REPOSITORY_COMPONENT_PATTERN.test(value) || value === '.' || value === '..') {
		throw configurationError()
	}
}

function isPositiveSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value > 0
}

function objectField(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

function configurationError(): Error {
	return new Error('GitHub App configuration is invalid')
}

function requestStatusError(status: number): Error {
	return new Error(`GitHub App request failed with status ${status}`)
}

function responseError(): Error {
	return new Error('GitHub App response is invalid')
}

function abortError(): DOMException {
	return new DOMException('GitHub App request was aborted', 'AbortError')
}

function timeoutError(): DOMException {
	return new DOMException('GitHub App request timed out', 'TimeoutError')
}

function utf8(text: string): Uint8Array<ArrayBuffer> {
	const encoded = new TextEncoder().encode(text)
	const buffer = new ArrayBuffer(encoded.byteLength)
	const view = new Uint8Array(buffer)
	view.set(encoded)
	return view
}

function base64url(bytes: Uint8Array): string {
	let binary = ''
	for (const byte of bytes) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function derTlv(tag: number, content: Uint8Array): Uint8Array<ArrayBuffer> {
	let lengthBytes: number[]
	if (content.length < 0x80) {
		lengthBytes = [content.length]
	} else {
		const big: number[] = []
		let length = content.length
		while (length > 0) {
			big.unshift(length & 0xff)
			length >>= 8
		}
		lengthBytes = [0x80 | big.length, ...big]
	}
	const out = new Uint8Array(1 + lengthBytes.length + content.length)
	out[0] = tag
	out.set(lengthBytes, 1)
	out.set(content, 1 + lengthBytes.length)
	return out
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
	const version = new Uint8Array([0x02, 0x01, 0x00])
	const algorithmId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00])
	const privateKey = derTlv(0x04, pkcs1)
	const inner = new Uint8Array(version.length + algorithmId.length + privateKey.length)
	inner.set(version, 0)
	inner.set(algorithmId, version.length)
	inner.set(privateKey, version.length + algorithmId.length)
	return derTlv(0x30, inner)
}
