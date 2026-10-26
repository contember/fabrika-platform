import { z } from 'zod'
import { GITHUB_ACCEPT, GITHUB_API_VERSION } from './transport'
import type { CreatedGitHubApp, GitHubAppManifestExchangeOptions, GitHubAppManifestInput } from './types'
import { appReferenceSchema, hasAsciiControl } from './validation'

const GITHUB_MANIFEST_USER_AGENT = 'fabrika'
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const MANIFEST_CODE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const MANIFEST_CONVERSION_TIMEOUT_MS = 30_000
const MAX_MANIFEST_CONVERSION_BYTES = 128 * 1024
const MAX_MANIFEST_URL_LENGTH = 2048

const manifestConversionSchema = appReferenceSchema.extend({
	pem: z.string().min(1).max(64 * 1024),
	webhook_secret: z.string().min(1).max(4096).refine((secret) => !hasAsciiControl(secret)),
})

/**
 * Build the one App manifest used by Fabrika repository source and MCP authoring. The write permissions serve
 * MCP authoring's branches and pull requests (`openRepository`); deploy tokens are minted with Contents read only.
 */
export function buildGitHubAppManifest(input: GitHubAppManifestInput): Readonly<Record<string, unknown>> {
	validateManifestInput(input)
	return {
		name: input.appName,
		url: input.homepageUrl,
		hook_attributes: { url: input.webhookUrl, active: true },
		...(input.redirectUrl === undefined ? {} : { redirect_url: input.redirectUrl }),
		...(input.setupUrl === undefined ? {} : { setup_url: input.setupUrl, setup_on_update: true }),
		public: input.public,
		default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
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
					// Workers refuse `redirect: 'error'`; a redirect is a response that is not `ok` and fails below.
					redirect: 'manual',
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
	if (input.setupUrl !== undefined) validateManifestUrl(input.setupUrl)
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
	const result = manifestConversionSchema.safeParse(value)
	if (!result.success) return null
	const { id, slug, html_url: htmlUrl, pem, webhook_secret: webhookSecret } = result.data
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
