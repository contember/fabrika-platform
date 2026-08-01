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
		await step('an anonymous Operations request reaches the real gateway', {
			intent: 'the proof starts without the synthetic DEV principal or a cached browser session',
			manual: 'Open Operations in a private browser with no Fabrika session.',
		}, async () => {
			const cookies = await getContext().cookies()
			expect(cookies.some((cookie) => cookie.name === 'px_session')).toBe(false)
		})

		await step('the gateway redirects the browser to IAM login', {
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
				const response = await getContext().request.post(`${BASE_URL}/operations/api/rpc`, {
					data: { method: 'sources', input: {} },
					headers: { origin: BASE_URL },
					failOnStatusCode: false,
				})
				expect(response.status()).toBe(401)
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
