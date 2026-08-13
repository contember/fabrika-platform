import {
	buildGitHubAppManifest,
	type CreatedGitHubApp,
	exchangeGitHubAppManifestCode as exchangeSharedGitHubAppManifestCode,
	type GitHubAppFetch,
	type GitHubAppManifestInput,
} from '@fabrika/github-app'
import { randomBytes } from 'node:crypto'
import { action, detail, info, ok, url } from './log'

export { buildGitHubAppManifest }
export type { CreatedGitHubApp, GitHubAppManifestInput }
export type GitHubAppManifestFetch = GitHubAppFetch

export interface GitHubAppManifestRuntime {
	readonly fetch?: GitHubAppManifestFetch
	readonly callbackTimeoutMs?: number
	readonly persistenceTimeoutMs?: number
	/** Receives the loopback entry point after the server starts. Useful to launch or test the browser handoff. */
	readonly onLocalUrl?: (localUrl: string) => void
	/** Persist the one-time credentials before the browser or caller is told creation succeeded. */
	readonly onCreated?: (app: CreatedGitHubApp, signal: AbortSignal) => Promise<void>
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000
const MAX_CALLBACK_TIMEOUT_MS = 60 * 60 * 1000
const DEFAULT_PERSISTENCE_TIMEOUT_MS = 30 * 1000
const MAX_PERSISTENCE_TIMEOUT_MS = 5 * 60 * 1000
const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

/** Backward-compatible positional wrapper around the runtime-neutral GitHub App exchange. */
export const exchangeGitHubAppManifestCode = (
	code: string,
	fetchImplementation?: GitHubAppManifestFetch,
	timeoutMs?: number,
): Promise<CreatedGitHubApp> =>
	exchangeSharedGitHubAppManifestCode(code, {
		...(fetchImplementation === undefined ? {} : { fetch: fetchImplementation }),
		...(timeoutMs === undefined ? {} : { timeoutMs }),
	})

const persistCreatedApp = async (
	app: CreatedGitHubApp,
	onCreated: GitHubAppManifestRuntime['onCreated'],
	timeoutMs: number,
): Promise<void> => {
	if (onCreated === undefined) return
	const controller = new AbortController()
	let rejectTimeout: (error: Error) => void
	const timeout = new Promise<never>((_resolve, reject) => {
		rejectTimeout = reject
	})
	const timer = setTimeout(() => {
		rejectTimeout(new Error('GitHub App credential persistence timed out'))
		controller.abort()
	}, timeoutMs)
	try {
		await Promise.race([onCreated(app, controller.signal), timeout])
		if (controller.signal.aborted) throw new Error('GitHub App credential persistence timed out')
	} catch {
		throw new Error('GitHub App credential persistence failed')
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
	const persistenceTimeoutMs = runtime.persistenceTimeoutMs ?? DEFAULT_PERSISTENCE_TIMEOUT_MS
	if (!Number.isSafeInteger(persistenceTimeoutMs) || persistenceTimeoutMs <= 0 || persistenceTimeoutMs > MAX_PERSISTENCE_TIMEOUT_MS) {
		throw new Error('GitHub App credential persistence timeout is invalid')
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
						await persistCreatedApp(app, runtime.onCreated, persistenceTimeoutMs)
						resolveApp(app)
						return new Response(renderDonePage(), { headers: { 'content-type': 'text/html; charset=utf-8' } })
					} catch {
						rejectApp(new Error('GitHub App manifest callback failed'))
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
	} catch (error) {
		// The callback failure page needs the same flush window as the success page.
		await Bun.sleep(25)
		throw error
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
