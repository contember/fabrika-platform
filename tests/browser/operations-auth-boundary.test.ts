import { browserTest, expect, getContext, getPage, invariant, step } from '@opice/harness'

const BASE_URL = process.env['FABRIKA_BROWSER_BASE_URL'] ?? 'http://control.fabrika.localhost:18080'
const IAM_URL = process.env['FABRIKA_BROWSER_IAM_ORIGIN'] ?? 'http://iam.fabrika.localhost:18080'
const PROTECTED_FIXTURE_TEXT = ['Browser Notes / test', 'Hidden sibling / secret', 'Browser fixture primary failure']

browserTest(
	{
		name: 'Operations sends an anonymous browser to IAM',
		url: `${BASE_URL}/operations/errors`,
		feature: 'operations-adoption-auth',
		seeds: ['local-stack'],
		roles: ['anonymous'],
		tier: 'critical',
	},
	async () => {
		await step('an anonymous Operations request reaches the real proxy', {
			intent: 'the proof starts with no Fabrika session at all — no cookie, and no dev persona behind the proxy',
			manual: 'Open Operations in a private browser with no Fabrika session.',
		}, async () => {
			const cookies = await getContext().cookies()
			expect(cookies.some((cookie) => cookie.name === 'px_session')).toBe(false)
		})

		await step('the proxy refuses the console before it reaches the application', {
			intent: 'the refusal is the enforcement point matching a `human` gate, not the app answering for itself',
			manual: 'Request the Operations console URL without following redirects. Verify that it answers 302 to IAM.',
		}, async () => {
			const response = await getContext().request.get(`${BASE_URL}/operations/errors`, { failOnStatusCode: false, maxRedirects: 0 })
			expect(response.status()).toBe(302)
			const location = new URL(response.headers()['location'] ?? '')
			expect(`${location.origin}${location.pathname}`).toBe(`${IAM_URL}/auth/login`)
			expect(location.searchParams.get('app')).toBe('vozka')
			expect(location.searchParams.get('redirect')).toBe(`${BASE_URL}/operations/errors`)
		})

		await step('the browser lands on IAM login', {
			intent: 'Operations authentication stays owned by IAM and does not render protected console data anonymously',
			manual: 'Verify that the browser leaves the Operations page and opens the IAM login boundary.',
		}, async () => {
			await expect.poll(() => {
				const url = new URL(getPage().url())
				return `${url.origin}${url.pathname}`
			}).toBe(`${IAM_URL}/auth/login`)

			const loginUrl = new URL(getPage().url())
			expect(loginUrl.searchParams.get('redirect')).toBe(`${BASE_URL}/operations/errors`)
		})

		await invariant(
			'no Operations source or issue data renders before authentication',
			async () => {
				// 302, not 401: gates are path-only, so the proxy answers an anonymous RPC the same way it
				// answers an anonymous page — and either way the request stops there.
				const response = await getContext().request.post(`${BASE_URL}/operations/api/rpc`, {
					data: { method: 'sources', input: {} },
					headers: { origin: BASE_URL },
					failOnStatusCode: false,
					maxRedirects: 0,
				})
				expect(response.status()).toBe(302)
				const responseBody = await response.text()
				const pageBody = getPage().locator('body')
				for (const protectedText of PROTECTED_FIXTURE_TEXT) {
					expect(responseBody).not.toContain(protectedText)
					await expect(pageBody).not.toContainText(protectedText)
				}
			},
		)
	},
)
