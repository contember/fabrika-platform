import { randomBytes } from 'node:crypto'
import { action, detail, info, ok, url } from './log'

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
	/** GitHub requires a public App when repositories outside its owner organization need it. */
	readonly public: boolean
}

export type GitHubAppManifestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface GitHubAppManifestRuntime {
	readonly fetch?: GitHubAppManifestFetch
	readonly callbackTimeoutMs?: number
	/** Receives the loopback entry point after the server starts. Useful to launch or test the browser handoff. */
	readonly onLocalUrl?: (localUrl: string) => void
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CALLBACK_TIMEOUT_MS = 60 * 60 * 1000
const CONVERSION_TIMEOUT_MS = 30 * 1000
const MAX_CONVERSION_BYTES = 128 * 1024
const ORGANIZATION_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/
const MANIFEST_CODE_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

const hasAsciiControl = (value: string): boolean => {
	for (const character of value) {
		const code = character.charCodeAt(0)
		if (code < 32 || code === 127) return true
	}
	return false
}

const objectField = (value: unknown, key: string): unknown => {
	if (typeof value !== 'object' || value === null) return undefined
	return Reflect.get(value, key)
}

const safeHttpsUrl = (value: string): URL => {
	let parsed: URL
	try {
		parsed = new URL(value)
	} catch {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	return parsed
}

const validateInput = (input: GitHubAppManifestInput): void => {
	if (
		!ORGANIZATION_PATTERN.test(input.organization) || input.appName.length === 0 || input.appName.length > 100 || hasAsciiControl(input.appName)
	) {
		throw new Error('GitHub App manifest configuration is invalid')
	}
	safeHttpsUrl(input.homepageUrl)
	safeHttpsUrl(input.webhookUrl)
}

/** Build the one App shape every Fabrika installation uses for repository source and push events. */
export const buildGitHubAppManifest = (input: GitHubAppManifestInput): Readonly<Record<string, unknown>> => {
	validateInput(input)
	return {
		name: input.appName,
		url: input.homepageUrl,
		hook_attributes: { url: input.webhookUrl, active: true },
		public: input.public,
		default_permissions: { contents: 'read' },
		default_events: ['push'],
	}
}

const parseConversion = (value: unknown): CreatedGitHubApp | null => {
	const id = objectField(value, 'id')
	const slug = objectField(value, 'slug')
	const htmlUrl = objectField(value, 'html_url')
	const pem = objectField(value, 'pem')
	const webhookSecret = objectField(value, 'webhook_secret')
	if (
		typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0 || typeof slug !== 'string' || !APP_SLUG_PATTERN.test(slug)
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

const readChunk = (
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal: AbortSignal,
): Promise<{ readonly done: true } | { readonly done: false; readonly value: Uint8Array }> => {
	if (signal.aborted) return Promise.reject(new Error('GitHub App manifest conversion timed out'))
	return new Promise((resolve, reject) => {
		const abort = (): void => {
			cleanup()
			reject(new Error('GitHub App manifest conversion timed out'))
		}
		const cleanup = (): void => signal.removeEventListener('abort', abort)
		signal.addEventListener('abort', abort, { once: true })
		reader.read().then(
			(result) => {
				cleanup()
				resolve(result.done ? { done: true } : { done: false, value: result.value })
			},
			() => {
				cleanup()
				reject(new Error(signal.aborted ? 'GitHub App manifest conversion timed out' : 'GitHub App manifest conversion returned an invalid response'))
			},
		)
	})
}

const readBoundedJson = async (response: Response, signal: AbortSignal): Promise<unknown> => {
	const contentLength = response.headers.get('content-length')
	if (contentLength !== null && /^[0-9]+$/.test(contentLength) && Number(contentLength) > MAX_CONVERSION_BYTES) {
		throw new Error('GitHub App manifest conversion returned an invalid response')
	}
	const reader = response.body?.getReader()
	if (reader === undefined) throw new Error('GitHub App manifest conversion returned an invalid response')
	const chunks: Uint8Array[] = []
	let total = 0
	try {
		while (true) {
			const result = await readChunk(reader, signal)
			if (result.done) break
			total += result.value.byteLength
			if (total > MAX_CONVERSION_BYTES) throw new Error('GitHub App manifest conversion returned an invalid response')
			chunks.push(result.value)
		}
	} catch (error) {
		void reader.cancel().catch(() => {})
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
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
	} catch {
		throw new Error('GitHub App manifest conversion returned an invalid response')
	}
}

/** Exchange the one-time manifest code. The returned PEM and webhook secret are never logged. */
export const exchangeGitHubAppManifestCode = async (
	code: string,
	fetchImplementation: GitHubAppManifestFetch = fetch,
	timeoutMs = CONVERSION_TIMEOUT_MS,
): Promise<CreatedGitHubApp> => {
	if (!MANIFEST_CODE_PATTERN.test(code)) throw new Error('GitHub App manifest callback is invalid')
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CONVERSION_TIMEOUT_MS) {
		throw new Error('GitHub App manifest conversion timeout is invalid')
	}
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), timeoutMs)
	try {
		let response: Response
		try {
			response = await fetchImplementation(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
				method: 'POST',
				headers: {
					accept: 'application/vnd.github+json',
					'user-agent': 'fabrika-cli',
					'x-github-api-version': '2022-11-28',
				},
				redirect: 'error',
				signal: controller.signal,
			})
		} catch {
			throw new Error(controller.signal.aborted ? 'GitHub App manifest conversion timed out' : 'GitHub App manifest conversion failed')
		}
		if (!response.ok) throw new Error('GitHub App manifest conversion failed')
		const app = parseConversion(await readBoundedJson(response, controller.signal))
		if (app === null) throw new Error('GitHub App manifest conversion returned an invalid response')
		return app
	} finally {
		clearTimeout(timer)
	}
}

/** Run GitHub's browser manifest handshake on a loopback-only callback server. */
export async function createGitHubAppViaManifest(
	input: GitHubAppManifestInput,
	runtime: GitHubAppManifestRuntime = {},
): Promise<CreatedGitHubApp> {
	const callbackTimeoutMs = runtime.callbackTimeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS
	if (!Number.isSafeInteger(callbackTimeoutMs) || callbackTimeoutMs <= 0 || callbackTimeoutMs > MAX_CALLBACK_TIMEOUT_MS) {
		throw new Error('GitHub App manifest callback timeout is invalid')
	}
	const state = randomBytes(16).toString('hex')
	const manifest = buildGitHubAppManifest(input)
	let resolveApp: (app: CreatedGitHubApp) => void
	let rejectApp: (error: Error) => void
	const appPromise = new Promise<CreatedGitHubApp>((resolve, reject) => {
		resolveApp = resolve
		rejectApp = reject
	})
	let callbackStarted = false
	let callbackTimer: ReturnType<typeof setTimeout> | undefined
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response('starting', { status: 503 }),
	})
	const localUrl = `http://127.0.0.1:${server.port}/`
	const fullManifest = { ...manifest, redirect_url: `${localUrl}callback` }
	try {
		server.reload({
			fetch: async (request: Request): Promise<Response> => {
				const requestUrl = new URL(request.url)
				if (request.headers.get('host') !== `127.0.0.1:${server.port}` || requestUrl.origin !== localUrl.slice(0, -1)) {
					return new Response('not found', { status: 404 })
				}
				if (request.method === 'GET' && requestUrl.pathname === '/') {
					return new Response(renderFormPage(input.organization, fullManifest, state), {
						headers: { 'content-type': 'text/html; charset=utf-8' },
					})
				}
				if (request.method === 'GET' && requestUrl.pathname === '/callback') {
					if (requestUrl.searchParams.get('state') !== state) {
						return new Response(renderErrorPage(), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
					}
					const code = requestUrl.searchParams.get('code')
					if (callbackStarted || code === null || code === '') {
						return new Response(renderErrorPage(), { status: 409, headers: { 'content-type': 'text/html; charset=utf-8' } })
					}
					callbackStarted = true
					if (callbackTimer !== undefined) clearTimeout(callbackTimer)
					try {
						const app = await exchangeGitHubAppManifestCode(code, runtime.fetch)
						resolveApp(app)
						return new Response(renderDonePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
					} catch {
						rejectApp(new Error('GitHub App manifest conversion failed'))
						return new Response(renderErrorPage(), { status: 400, headers: { 'content-type': 'text/html; charset=utf-8' } })
					}
				}
				return new Response('not found', { status: 404 })
			},
		})
		const timeout = new Promise<never>((_resolve, reject) => {
			callbackTimer = setTimeout(() => reject(new Error('Timed out waiting for the GitHub App manifest callback')), callbackTimeoutMs)
		})
		runtime.onLocalUrl?.(localUrl)
		action('OPERATOR ACTION — create the GitHub App', [
			`1. Open: ${url(localUrl)}`,
			'2. Review the preconfigured GitHub App and click Create GitHub App.',
			'3. Return here after GitHub redirects the browser back to this machine.',
		])
		info('Waiting for the GitHub App manifest callback…')
		const app = await Promise.race([appPromise, timeout])
		ok(`GitHub App created: ${app.slug} (id ${app.id})`)
		detail(`App settings: ${app.htmlUrl}`)
		// Let Bun flush the callback page before the loopback server disappears.
		await Bun.sleep(25)
		return app
	} finally {
		if (callbackTimer !== undefined) clearTimeout(callbackTimer)
		server.stop(true)
	}
}

export const githubAppInstallationUrl = (slug: string): string => {
	if (!APP_SLUG_PATTERN.test(slug)) throw new Error('GitHub App slug is invalid')
	return `https://github.com/apps/${slug}/installations/new`
}

const renderFormPage = (organization: string, manifest: Readonly<Record<string, unknown>>, state: string): string => {
	const githubUrl = `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new?state=${encodeURIComponent(state)}`
	const manifestJson = htmlEscape(JSON.stringify(manifest))
	return `<!doctype html>
<html><head><meta charset="utf-8"><title>Create Fabrika GitHub App</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>Creating the Fabrika GitHub App…</h1>
	<p>Submitting the manifest to GitHub. If nothing happens, click the button below.</p>
	<form id="manifest-form" method="post" action="${htmlEscape(githubUrl)}">
		<input type="hidden" name="manifest" value="${manifestJson}">
		<button type="submit">Continue to GitHub</button>
	</form>
	<script>document.getElementById('manifest-form').submit()</script>
</body></html>`
}

const renderDonePage = (): string =>
	`<!doctype html>
<html><head><meta charset="utf-8"><title>Done</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>&#10003; GitHub App created</h1>
	<p>Return to your terminal to install the App on the selected repositories.</p>
</body></html>`

const renderErrorPage = (): string =>
	`<!doctype html>
<html><head><meta charset="utf-8"><title>Error</title></head>
<body style="font-family: system-ui; max-width: 40rem; margin: 4rem auto; text-align: center;">
	<h1>&#10007; GitHub App setup failed</h1>
	<p>Return to your terminal for a detail-free error.</p>
</body></html>`

const htmlEscape = (value: string): string =>
	value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
