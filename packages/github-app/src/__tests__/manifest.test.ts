import { describe, expect, test } from 'bun:test'
import { buildGitHubAppManifest, exchangeGitHubAppManifestCode, type GitHubAppFetch } from '../index'

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

describe('GitHub App manifest contract', () => {
	test('builds the exact least-authority manifest including an optional callback', () => {
		expect(
			buildGitHubAppManifest({
				organization: 'contember',
				appName: 'fabrika-test',
				homepageUrl: 'https://control.example.test',
				webhookUrl: 'https://control.example.test/webhooks/github',
				redirectUrl: 'https://control.example.test/admin/source/github/callback',
				public: false,
			}),
		).toEqual({
			name: 'fabrika-test',
			url: 'https://control.example.test',
			hook_attributes: { url: 'https://control.example.test/webhooks/github', active: true },
			redirect_url: 'https://control.example.test/admin/source/github/callback',
			public: false,
			default_permissions: { contents: 'read' },
			default_events: ['push'],
		})
	})

	test.each([
		{ organization: '../owner', appName: 'fabrika', homepageUrl: 'https://control.test', webhookUrl: 'https://control.test/hook', public: false },
		{ organization: 'owner', appName: '', homepageUrl: 'https://control.test', webhookUrl: 'https://control.test/hook', public: false },
		{ organization: 'owner', appName: 'fabrika', homepageUrl: 'http://control.test', webhookUrl: 'https://control.test/hook', public: false },
		{
			organization: 'owner',
			appName: 'fabrika',
			homepageUrl: 'https://control.test',
			webhookUrl: 'https://user@control.test/hook',
			public: false,
		},
		{
			organization: 'owner',
			appName: 'fabrika',
			homepageUrl: 'https://control.test',
			webhookUrl: 'https://control.test/hook',
			redirectUrl: 'https://control.test/callback#secret',
			public: false,
		},
	])('rejects unsafe manifest input %#', (input) => {
		expect(() => buildGitHubAppManifest(input)).toThrow('configuration is invalid')
	})

	test('exchanges the one-time code with fixed GitHub transport metadata', async () => {
		const calls: Array<{ readonly url: string; readonly init?: RequestInit }> = []
		const fetchImplementation: GitHubAppFetch = (input, init) => {
			calls.push({ url: String(input), ...(init === undefined ? {} : { init }) })
			return Promise.resolve(Response.json(conversion()))
		}
		expect(await exchangeGitHubAppManifestCode('one-time-code', { fetch: fetchImplementation })).toEqual({
			id: 123,
			slug: 'fabrika-test',
			htmlUrl: 'https://github.com/apps/fabrika-test',
			pem: PEM,
			webhookSecret: 'generated-webhook-secret',
		})
		expect(calls[0]?.url).toBe('https://api.github.com/app-manifests/one-time-code/conversions')
		expect(calls[0]?.init?.method).toBe('POST')
		expect(calls[0]?.init?.redirect).toBe('error')
		const headers = new Headers(calls[0]?.init?.headers)
		expect(headers.get('authorization')).toBeNull()
		expect(headers.get('user-agent')).toBe('fabrika')
		expect(headers.get('x-github-api-version')).toBe('2022-11-28')
	})

	test('honors caller cancellation before transport', async () => {
		let calls = 0
		const controller = new AbortController()
		controller.abort()
		const fetchImplementation: GitHubAppFetch = () => {
			calls += 1
			return Promise.resolve(Response.json(conversion()))
		}
		const raised = await exchangeGitHubAppManifestCode('one-time-code', { fetch: fetchImplementation, signal: controller.signal }).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(raised).toBeInstanceOf(DOMException)
		expect(raised instanceof DOMException ? raised.name : '').toBe('AbortError')
		expect(calls).toBe(0)
	})

	test('bounds and redacts every conversion response', async () => {
		const sentinel = 'private-upstream-detail'
		const cases: GitHubAppFetch[] = [
			() => Promise.resolve(new Response(sentinel, { status: 500 })),
			() => Promise.resolve(Response.json(conversion({ html_url: `https://evil.example/${sentinel}` }))),
			() => Promise.resolve(new Response(JSON.stringify({ value: sentinel }).repeat(20_000))),
		]
		for (const fetchImplementation of cases) {
			const raised = await exchangeGitHubAppManifestCode('one-time-code', { fetch: fetchImplementation }).then(
				() => undefined,
				(error: unknown) => error,
			)
			expect(raised).toBeInstanceOf(Error)
			expect(raised instanceof Error ? raised.message : sentinel).not.toContain(sentinel)
		}
	})

	test('rejects invalid and missing conversion credentials', async () => {
		for (
			const overrides of [
				{ id: 0 },
				{ slug: '../app' },
				{ html_url: 'https://github.com/apps/other' },
				{ pem: 'not a private key' },
				{ webhook_secret: 'secret\nvalue' },
			]
		) {
			await expect(
				exchangeGitHubAppManifestCode('one-time-code', { fetch: () => Promise.resolve(Response.json(conversion(overrides))) }),
			).rejects.toThrow('invalid response')
		}
	})
})
