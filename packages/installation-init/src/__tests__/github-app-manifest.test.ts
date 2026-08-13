import { describe, expect, test } from 'bun:test'
import {
	buildGitHubAppManifest,
	createGitHubAppViaManifest,
	exchangeGitHubAppManifestCode,
	githubAppInstallationUrl,
	type GitHubAppManifestFetch,
} from '../github-app-manifest'

const PEM = `-----BEGIN RSA PRIVATE KEY-----
ZmFrZQ==
-----END RSA PRIVATE KEY-----`

const conversion = (overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> => ({
	id: 123,
	slug: 'fabrika-test',
	html_url: 'https://github.com/apps/fabrika-test',
	pem: PEM,
	webhook_secret: 'generated-webhook-secret',
	...overrides,
})

describe('GitHub App manifest mechanic', () => {
	test('builds the exact least-authority repository App manifest', () => {
		expect(
			buildGitHubAppManifest({
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			}),
		).toEqual({
			name: 'fabrika-test',
			url: 'https://control.example.test',
			hook_attributes: { url: 'https://control.example.test/webhooks/github', active: true },
			public: false,
			default_permissions: { contents: 'read' },
			default_events: ['push'],
		})
		expect(() =>
			buildGitHubAppManifest({
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'http://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			})
		).toThrow('configuration is invalid')
	})

	test('exchanges a bounded one-time code with exact GitHub headers and no redirects', async () => {
		const calls: Array<{ url: string; init?: RequestInit }> = []
		const fetchImplementation: GitHubAppManifestFetch = (input, init) => {
			calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
			return Promise.resolve(Response.json(conversion()))
		}
		expect(await exchangeGitHubAppManifestCode('temporary-code', fetchImplementation)).toEqual({
			id: 123,
			slug: 'fabrika-test',
			htmlUrl: 'https://github.com/apps/fabrika-test',
			pem: PEM,
			webhookSecret: 'generated-webhook-secret',
		})
		expect(calls[0]?.url).toBe('https://api.github.com/app-manifests/temporary-code/conversions')
		expect(calls[0]?.init?.method).toBe('POST')
		expect(calls[0]?.init?.redirect).toBe('error')
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('x-github-api-version')).toBe('2022-11-28')
		expect(headers.get('authorization')).toBeNull()
	})

	test('rejects hostile conversion responses without echoing their body', async () => {
		const sentinel = 'private-upstream-detail'
		const cases: GitHubAppManifestFetch[] = [
			() => Promise.resolve(new Response(sentinel, { status: 500 })),
			() => Promise.resolve(Response.json(conversion({ html_url: `https://evil.example/${sentinel}` }))),
			() => Promise.resolve(new Response(JSON.stringify({ value: sentinel }).repeat(20_000))),
		]
		for (const fetchImplementation of cases) {
			const raised = await exchangeGitHubAppManifestCode('temporary-code', fetchImplementation).then(
				() => undefined,
				(error: unknown) => error,
			)
			expect(raised).toBeInstanceOf(Error)
			expect(raised instanceof Error ? raised.message : sentinel).not.toContain(sentinel)
		}
	})

	test('applies the conversion deadline while reading a hanging response body', async () => {
		const hanging: GitHubAppManifestFetch = () =>
			Promise.resolve(
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{'))
						},
					}),
				),
			)
		await expect(exchangeGitHubAppManifestCode('temporary-code', hanging, 10)).rejects.toThrow('timed out')
	})

	test('keeps an invalid state from consuming the loopback callback', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: () => Promise.resolve(Response.json(conversion())),
				callbackTimeoutMs: 5_000,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
			},
		)
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		expect(state).toBeDefined()
		expect((await fetch(`${localUrl}callback?code=temporary-code&state=wrong`)).status).toBe(400)
		expect((await fetch(`${localUrl}callback?code=temporary-code&state=${state}`)).status).toBe(200)
		expect((await created).id).toBe(123)
	})

	test('lets an accepted callback finish under its own deadline', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		let conversionFinished = false
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: async () => {
					await Bun.sleep(100)
					conversionFinished = true
					return Response.json(conversion())
				},
				callbackTimeoutMs: 50,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
			},
		)
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		const callback = fetch(`${localUrl}callback?code=temporary-code&state=${state}`)
		expect((await created).id).toBe(123)
		expect(conversionFinished).toBe(true)
		expect((await callback).status).toBe(200)
	})

	test('does not acknowledge creation until the durable callback completes', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		let releasePersistence = (): void => {
			throw new Error('persistence did not start')
		}
		const persistence = new Promise<void>((resolve) => {
			releasePersistence = resolve
		})
		let markPersistenceStarted = (): void => {
			throw new Error('persistence latch was not initialized')
		}
		const persistenceStarted = new Promise<void>((resolve) => {
			markPersistenceStarted = resolve
		})
		let callbackFinished = false
		let creationFinished = false
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: () => Promise.resolve(Response.json(conversion())),
				callbackTimeoutMs: 5_000,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
				onCreated: async (app, signal) => {
					expect(app.pem).toBe(PEM)
					expect(app.webhookSecret).toBe('generated-webhook-secret')
					expect(signal.aborted).toBe(false)
					markPersistenceStarted()
					await persistence
				},
			},
		).then((app) => {
			creationFinished = true
			return app
		})
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		const callback = fetch(`${localUrl}callback?code=temporary-code&state=${state}`).then((response) => {
			callbackFinished = true
			return response
		})
		await persistenceStarted
		expect(callbackFinished).toBe(false)
		expect(creationFinished).toBe(false)
		releasePersistence()
		expect((await callback).status).toBe(200)
		expect((await created).id).toBe(123)
	})

	test('reports durable callback failures without exposing one-time credentials', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		const sentinel = `${PEM}\ngenerated-webhook-secret`
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: () => Promise.resolve(Response.json(conversion())),
				callbackTimeoutMs: 5_000,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
				onCreated: () => Promise.reject(new Error(sentinel)),
			},
		).then(
			(app) => ({ app }),
			(error: unknown) => ({ error }),
		)
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		const callback = await fetch(`${localUrl}callback?code=temporary-code&state=${state}`)
		const callbackText = await callback.text()
		const result = await created
		expect(callback.status).toBe(400)
		expect(callbackText).not.toContain('Done')
		expect(callbackText).not.toContain(PEM)
		expect(callbackText).not.toContain('generated-webhook-secret')
		const raised = 'error' in result ? result.error : undefined
		expect(raised).toBeInstanceOf(Error)
		expect(raised instanceof Error ? raised.message : sentinel).not.toContain(PEM)
		expect(raised instanceof Error ? raised.message : sentinel).not.toContain('generated-webhook-secret')
	})

	test('aborts a hanging durable callback and closes the loopback server', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		let observedAbort = false
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: () => Promise.resolve(Response.json(conversion())),
				callbackTimeoutMs: 5_000,
				persistenceTimeoutMs: 10,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
				onCreated: (_app, signal) =>
					new Promise<void>((resolve) => {
						const abort = (): void => {
							observedAbort = true
							resolve()
						}
						if (signal.aborted) abort()
						else signal.addEventListener('abort', abort, { once: true })
					}),
			},
		).then(
			(app) => ({ app }),
			(error: unknown) => ({ error }),
		)
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		const callback = await fetch(`${localUrl}callback?code=temporary-code&state=${state}`)
		const result = await created
		expect(callback.status).toBe(400)
		expect(observedAbort).toBe(true)
		expect('error' in result ? result.error : undefined).toBeInstanceOf(Error)
		await expect(fetch(localUrl)).rejects.toThrow()
	})

	test('does not persist a malformed GitHub conversion', async () => {
		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		let persistenceCalls = 0
		const created = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				fetch: () => Promise.resolve(Response.json(conversion({ pem: 'not-a-private-key' }))),
				callbackTimeoutMs: 5_000,
				onLocalUrl: (localUrl) => resolveUrl(localUrl),
				onCreated: () => {
					persistenceCalls += 1
					return Promise.resolve()
				},
			},
		).then(
			(app) => ({ app }),
			(error: unknown) => ({ error }),
		)
		const localUrl = await urlPromise
		const page = await (await fetch(localUrl)).text()
		const state = /settings\/apps\/new\?state=([a-f0-9]+)/.exec(page)?.[1]
		expect((await fetch(`${localUrl}callback?code=temporary-code&state=${state}`)).status).toBe(400)
		const result = await created
		expect(persistenceCalls).toBe(0)
		expect('error' in result ? result.error : undefined).toBeInstanceOf(Error)
	})

	test('stops the server when setup after bind fails and rejects a foreign Host', async () => {
		let localUrl = ''
		const failed = await createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{
				callbackTimeoutMs: 5_000,
				onLocalUrl: (value) => {
					localUrl = value
					throw new Error('presentation failed')
				},
			},
		).then(() => undefined, (error: unknown) => error)
		expect(failed).toBeInstanceOf(Error)
		await expect(fetch(localUrl)).rejects.toThrow()

		let resolveUrl: (value: string) => void
		const urlPromise = new Promise<string>((resolve) => {
			resolveUrl = resolve
		})
		const timed = createGitHubAppViaManifest(
			{
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				public: false,
			},
			{ callbackTimeoutMs: 100, onLocalUrl: (value) => resolveUrl(value) },
		)
		localUrl = await urlPromise
		expect((await fetch(localUrl, { headers: { host: 'attacker.example' } })).status).toBe(404)
		await expect(timed).rejects.toThrow('Timed out waiting')
	})

	test('builds only a validated GitHub installation URL', () => {
		expect(githubAppInstallationUrl('fabrika-test')).toBe('https://github.com/apps/fabrika-test/installations/new')
		expect(() => githubAppInstallationUrl('../credential')).toThrow('slug is invalid')
	})
})
