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

export interface GitHubAppInstallation {
	readonly id: number
	readonly accountLogin: string
	readonly accountType: 'Organization' | 'User'
	readonly repositorySelection: 'all' | 'selected'
}

export interface GitHubAppIdentity {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly public: boolean
	readonly permissions: {
		readonly contents: 'read'
	}
	readonly events: readonly string[]
	readonly owner: {
		readonly login: string
		readonly type: 'Organization' | 'User'
	}
}

export interface GitHubAppWebhookConfig {
	readonly url: string
	readonly contentType: 'json' | 'form'
	readonly insecureSsl: '0' | '1'
}

export interface GitHubAppWebhookUpdate {
	readonly url: string
	readonly secret: string
	readonly signal?: AbortSignal
}

export interface GitHubRepositoryTokenRequest {
	installationId: number
	owner: string
	repository: string
	signal?: AbortSignal
}

export type GitHubAppFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface CreatedGitHubApp {
	readonly id: number
	readonly slug: string
	readonly htmlUrl: string
	readonly pem: string
	readonly webhookSecret: string
}

export interface GitHubAppManifestInput {
	readonly organization: string
	readonly appName: string
	readonly homepageUrl: string
	readonly webhookUrl: string
	readonly redirectUrl?: string
	/** GitHub requires a public App when repositories outside its owner organization need it. */
	readonly public: boolean
}

export interface GitHubAppManifestExchangeOptions {
	readonly fetch?: GitHubAppFetch
	readonly signal?: AbortSignal
	readonly timeoutMs?: number
}

const DEFAULT_API_BASE_URL = 'https://api.github.com'
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const MAX_REQUEST_TIMEOUT_MS = 120_000
const MAX_RESPONSE_BYTES = 64 * 1024
const GITHUB_ACCEPT = 'application/vnd.github+json'
const GITHUB_API_VERSION = '2022-11-28'
const GITHUB_USER_AGENT = 'vozka'
const GITHUB_MANIFEST_USER_AGENT = 'fabrika'
const APP_ID_PATTERN = /^[1-9][0-9]*$/
const REPOSITORY_COMPONENT_PATTERN = /^[A-Za-z0-9_.-]+$/
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const MANIFEST_CODE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const MANIFEST_CONVERSION_TIMEOUT_MS = 30_000
const MAX_MANIFEST_CONVERSION_BYTES = 128 * 1024
const MAX_MANIFEST_URL_LENGTH = 2048
const NOT_FOUND = Symbol('not-found')

/** Build the one least-authority App manifest used by Fabrika repository source. */
export function buildGitHubAppManifest(input: GitHubAppManifestInput): Readonly<Record<string, unknown>> {
	validateManifestInput(input)
	return {
		name: input.appName,
		url: input.homepageUrl,
		hook_attributes: { url: input.webhookUrl, active: true },
		...(input.redirectUrl === undefined ? {} : { redirect_url: input.redirectUrl }),
		public: input.public,
		default_permissions: { contents: 'read' },
		default_events: ['push'],
	}
}

/** Exchange a bounded one-time GitHub manifest code without exposing response details. */
export async function exchangeGitHubAppManifestCode(
	code: string,
	options: GitHubAppManifestExchangeOptions = {},
): Promise<CreatedGitHubApp> {
	if (!MANIFEST_CODE_PATTERN.test(code)) throw new Error('GitHub App manifest callback is invalid')
	const timeoutMs = options.timeoutMs ?? MANIFEST_CONVERSION_TIMEOUT_MS
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MANIFEST_CONVERSION_TIMEOUT_MS) {
		throw new Error('GitHub App manifest conversion timeout is invalid')
	}
	const cancellation = createManifestCancellation(options.signal, timeoutMs)
	try {
		cancellation.throwIfCancelled()
		let response: Response
		try {
			response = await (options.fetch ?? fetch)(
				`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
				{
					method: 'POST',
					headers: {
						accept: GITHUB_ACCEPT,
						'user-agent': GITHUB_MANIFEST_USER_AGENT,
						'x-github-api-version': GITHUB_API_VERSION,
					},
					redirect: 'error',
					signal: cancellation.signal,
				},
			)
		} catch {
			cancellation.throwIfCancelled()
			throw new Error('GitHub App manifest conversion failed')
		}
		cancellation.throwIfCancelled()
		if (!response.ok) throw new Error('GitHub App manifest conversion failed')
		const app = decodeManifestConversion(await readManifestConversionJson(response, cancellation))
		if (app === null) throw new Error('GitHub App manifest conversion returned an invalid response')
		return app
	} finally {
		cancellation.dispose()
	}
}

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

	/** Read and bind the public identity represented by this client's App credentials. */
	async getAuthenticatedApp(signal?: AbortSignal): Promise<GitHubAppIdentity> {
		const body = await this.requestJson('/app', {}, signal, false)
		if (body === NOT_FOUND) throw responseError()
		const identity = decodeAppIdentity(body)
		if (identity === null || String(identity.id) !== this.appId) throw responseError()
		return identity
	}

	/** Read the App webhook transport settings without exposing GitHub's masked secret field. */
	async getWebhookConfig(signal?: AbortSignal): Promise<GitHubAppWebhookConfig> {
		const body = await this.requestJson('/app/hook/config', {}, signal, false)
		if (body === NOT_FOUND) throw responseError()
		const config = decodeWebhookConfig(body)
		if (config === null) throw responseError()
		return config
	}

	/** Set the App webhook to JSON over verified TLS and bind GitHub's response to that request. */
	async updateWebhookConfig(input: GitHubAppWebhookUpdate): Promise<GitHubAppWebhookConfig> {
		const webhookUrl = normalizeWebhookUrl(input.url)
		validateWebhookSecret(input.secret)
		const body = await this.requestJson(
			'/app/hook/config',
			{
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ url: webhookUrl, content_type: 'json', insecure_ssl: '0', secret: input.secret }),
			},
			input.signal,
			false,
		)
		if (body === NOT_FOUND) throw responseError()
		const config = decodeWebhookConfig(body)
		if (config === null || config.url !== webhookUrl || config.contentType !== 'json' || config.insecureSsl !== '0') {
			throw responseError()
		}
		return config
	}

	/** Resolve the App installation owned by one organization. A 404 is an expected miss. */
	async resolveOrganizationInstallationId(organization: string, signal?: AbortSignal): Promise<number | null> {
		return (await this.resolveOrganizationInstallation(organization, signal))?.id ?? null
	}

	/** Resolve and strictly bind the installation authority owned by one organization. */
	async resolveOrganizationInstallation(organization: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null> {
		validateRepositoryComponent(organization)
		const body = await this.requestJson(`/orgs/${organization}/installation`, {}, signal, true)
		if (body === NOT_FOUND) return null
		return this.decodeInstallation(body, organization, 'Organization')
	}

	/** Resolve the App installation for one GitHub repository. A 404 is an expected miss. */
	async resolveInstallationId(owner: string, repository: string, signal?: AbortSignal): Promise<number | null> {
		return (await this.resolveRepositoryInstallation(owner, repository, signal))?.id ?? null
	}

	/** Resolve and strictly bind the installation authority that grants one repository. */
	async resolveRepositoryInstallation(owner: string, repository: string, signal?: AbortSignal): Promise<GitHubAppInstallation | null> {
		validateRepositoryComponent(owner)
		validateRepositoryComponent(repository)
		const body = await this.requestJson(`/repos/${owner}/${repository}/installation`, {}, signal, true)
		if (body === NOT_FOUND) {
			return null
		}
		return this.decodeInstallation(body, owner)
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

	private decodeInstallation(body: unknown, accountLogin: string, requiredType?: 'Organization' | 'User'): GitHubAppInstallation {
		const id = objectField(body, 'id')
		const appId = objectField(body, 'app_id')
		const targetType = objectField(body, 'target_type')
		const account = objectField(body, 'account')
		const login = objectField(account, 'login')
		const accountType = objectField(account, 'type')
		const repositorySelection = objectField(body, 'repository_selection')
		if (
			typeof id !== 'number' || !isPositiveSafeInteger(id) || typeof appId !== 'number' || !isPositiveSafeInteger(appId)
			|| String(appId) !== this.appId || (targetType !== 'Organization' && targetType !== 'User') || accountType !== targetType
			|| (requiredType !== undefined && targetType !== requiredType) || typeof login !== 'string'
			|| login.toLowerCase() !== accountLogin.toLowerCase()
			|| (repositorySelection !== 'all' && repositorySelection !== 'selected')
		) {
			throw responseError()
		}
		return { id, accountLogin: login, accountType: targetType, repositorySelection }
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

interface ManifestCancellation {
	readonly signal: AbortSignal
	throwIfCancelled(): void
	dispose(): void
}

function createManifestCancellation(callerSignal: AbortSignal | undefined, timeoutMs: number): ManifestCancellation {
	const controller = new AbortController()
	let timedOut = false
	const abortFromCaller = (): void => controller.abort()
	if (callerSignal?.aborted === true) controller.abort()
	else callerSignal?.addEventListener('abort', abortFromCaller, { once: true })
	const timer = setTimeout(() => {
		timedOut = true
		controller.abort()
	}, timeoutMs)
	return {
		signal: controller.signal,
		throwIfCancelled() {
			if (callerSignal?.aborted === true) throw new DOMException('GitHub App manifest conversion was aborted', 'AbortError')
			if (timedOut) throw new DOMException('GitHub App manifest conversion timed out', 'TimeoutError')
			if (controller.signal.aborted) throw new DOMException('GitHub App manifest conversion was aborted', 'AbortError')
		},
		dispose() {
			clearTimeout(timer)
			callerSignal?.removeEventListener('abort', abortFromCaller)
		},
	}
}

async function readManifestConversionJson(response: Response, cancellation: ManifestCancellation): Promise<unknown> {
	cancellation.throwIfCancelled()
	const contentLength = response.headers.get('content-length')
	if (contentLength !== null && /^[0-9]+$/.test(contentLength) && Number(contentLength) > MAX_MANIFEST_CONVERSION_BYTES) {
		throw new Error('GitHub App manifest conversion returned an invalid response')
	}
	const reader = response.body?.getReader()
	if (reader === undefined) throw new Error('GitHub App manifest conversion returned an invalid response')
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readManifestChunk(reader, cancellation)
			if (result.done) break
			total += result.value.byteLength
			if (total > MAX_MANIFEST_CONVERSION_BYTES) throw new Error('GitHub App manifest conversion returned an invalid response')
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
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		cancellation.throwIfCancelled()
		throw new Error('GitHub App manifest conversion returned an invalid response')
	}
}

function readManifestChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	cancellation: ManifestCancellation,
): Promise<{ readonly done: true } | { readonly done: false; readonly value: Uint8Array }> {
	cancellation.throwIfCancelled()
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			cleanup()
			try {
				cancellation.throwIfCancelled()
			} catch (error) {
				reject(error)
			}
		}
		const cleanup = (): void => cancellation.signal.removeEventListener('abort', abort)
		cancellation.signal.addEventListener('abort', abort, { once: true })
		reader.read().then(
			(result) => {
				cleanup()
				resolve(result.done ? { done: true } : { done: false, value: result.value })
			},
			() => {
				cleanup()
				try {
					cancellation.throwIfCancelled()
					reject(new Error('GitHub App manifest conversion returned an invalid response'))
				} catch (error) {
					reject(error)
				}
			},
		)
	})
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

function normalizeWebhookUrl(value: string): string {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw configurationError()
	}
	if (
		url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '' || url.hostname === ''
	) {
		throw configurationError()
	}
	return url.toString()
}

function validateManifestInput(input: GitHubAppManifestInput): void {
	if (
		!ORGANIZATION_PATTERN.test(input.organization) || input.appName.length === 0 || input.appName.length > 100
		|| hasAsciiControl(input.appName)
	) {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	validateManifestUrl(input.homepageUrl)
	validateManifestUrl(input.webhookUrl)
	if (input.redirectUrl !== undefined) validateManifestUrl(input.redirectUrl)
}

function validateManifestUrl(value: string): void {
	if (value.length === 0 || value.length > MAX_MANIFEST_URL_LENGTH || hasAsciiControl(value)) {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	if (
		parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '' || parsed.hostname === ''
	) {
		throw new Error('GitHub App manifest configuration is invalid')
	}
}

function decodeManifestConversion(value: unknown): CreatedGitHubApp | null {
	const id = objectField(value, 'id')
	const slug = objectField(value, 'slug')
	const htmlUrl = objectField(value, 'html_url')
	const pem = objectField(value, 'pem')
	const webhookSecret = objectField(value, 'webhook_secret')
	if (
		typeof id !== 'number' || !isPositiveSafeInteger(id) || typeof slug !== 'string' || !APP_SLUG_PATTERN.test(slug)
		|| typeof htmlUrl !== 'string' || typeof pem !== 'string' || typeof webhookSecret !== 'string'
		|| pem.length === 0 || pem.length > 64 * 1024 || webhookSecret.length === 0 || webhookSecret.length > 4096
		|| hasAsciiControl(webhookSecret)
	) {
		return null
	}
	let parsedHtmlUrl: URL
	try {
		parsedHtmlUrl = new URL(htmlUrl)
	} catch {
		return null
	}
	if (
		parsedHtmlUrl.protocol !== 'https:' || parsedHtmlUrl.hostname !== 'github.com' || parsedHtmlUrl.port !== ''
		|| parsedHtmlUrl.username !== '' || parsedHtmlUrl.password !== '' || parsedHtmlUrl.search !== '' || parsedHtmlUrl.hash !== ''
		|| parsedHtmlUrl.pathname !== `/apps/${slug}`
		|| !/^-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+-----END (?:RSA )?PRIVATE KEY-----\s*$/.test(pem)
	) {
		return null
	}
	return { id, slug, htmlUrl, pem, webhookSecret }
}

function validateWebhookSecret(value: string): void {
	if (value.length === 0 || value.length > 4096 || hasAsciiControl(value)) throw configurationError()
}

function decodeAppIdentity(value: unknown): GitHubAppIdentity | null {
	const id = objectField(value, 'id')
	const slug = objectField(value, 'slug')
	const htmlUrl = objectField(value, 'html_url')
	const publicApp = objectField(value, 'public')
	const permissions = objectField(value, 'permissions')
	const contents = objectField(permissions, 'contents')
	const events = objectField(value, 'events')
	const owner = objectField(value, 'owner')
	const login = objectField(owner, 'login')
	const type = objectField(owner, 'type')
	if (
		typeof id !== 'number' || !isPositiveSafeInteger(id) || typeof slug !== 'string' || !APP_SLUG_PATTERN.test(slug)
		|| typeof htmlUrl !== 'string' || typeof login !== 'string' || login.length === 0 || login.length > 100
		|| !REPOSITORY_COMPONENT_PATTERN.test(login) || (type !== 'Organization' && type !== 'User') || typeof publicApp !== 'boolean'
		|| contents !== 'read' || !hasExactAppPermissions(permissions) || !isStringArray(events) || !events.includes('push')
	) {
		return null
	}
	let parsedHtmlUrl: URL
	try {
		parsedHtmlUrl = new URL(htmlUrl)
	} catch {
		return null
	}
	if (
		parsedHtmlUrl.protocol !== 'https:' || parsedHtmlUrl.hostname !== 'github.com' || parsedHtmlUrl.port !== ''
		|| parsedHtmlUrl.username !== '' || parsedHtmlUrl.password !== '' || parsedHtmlUrl.search !== '' || parsedHtmlUrl.hash !== ''
		|| parsedHtmlUrl.pathname !== `/apps/${slug}`
	) {
		return null
	}
	return { id, slug, htmlUrl, public: publicApp, permissions: { contents }, events, owner: { login, type } }
}

function decodeWebhookConfig(value: unknown): GitHubAppWebhookConfig | null {
	const url = objectField(value, 'url')
	const contentType = objectField(value, 'content_type')
	const insecureSsl = objectField(value, 'insecure_ssl')
	if (typeof url !== 'string' || (contentType !== 'json' && contentType !== 'form')) return null
	let normalized: string
	try {
		normalized = normalizeWebhookUrl(url)
	} catch {
		return null
	}
	if (normalized !== url) return null
	if (insecureSsl !== '0' && insecureSsl !== '1' && insecureSsl !== 0 && insecureSsl !== 1) return null
	return { url, contentType, insecureSsl: String(insecureSsl) === '0' ? '0' : '1' }
}

function hasAsciiControl(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 100)
}

function hasExactAppPermissions(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || objectField(value, 'contents') !== 'read') return false
	const keys = Object.keys(value)
	if (keys.some((key) => key !== 'contents' && key !== 'metadata')) return false
	const metadata = objectField(value, 'metadata')
	return metadata === undefined || metadata === 'read'
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
