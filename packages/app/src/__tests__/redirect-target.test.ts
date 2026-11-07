// `redirect()`: the handler's `{ to }` is answered as a redirect only to a path of the application's own origin or a
// listed origin. A path a browser would read a host from — after stripping a tab or a newline, or reading `\` as `/` —
// fails the invocation instead of leaving as `Location`.

import { defineApp, defineVocabulary, redirect } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'

const vocabulary = defineVocabulary({
	app: 'returning',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: { reader: { grants: ['projects.read'] } },
})
const app = defineApp(vocabulary)

const flow = app.group({ callers: ['human'] }, (r) => ({
	next: r.mutation({
		input: z.strictObject({ to: z.string() }),
		output: redirect({ origins: ['https://partner.example'] }),
		access: { action: 'projects.read', app: true },
	}).handle(({ input }) => ({ to: input.to })),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { flow }) }))

describe('a redirect target', () => {
	const kit = testKit(serve(contract, { database: null }))
	const call = kit.browser(kit.testCaller([{ action: 'projects.read' }]))
	const redirectTo = (to: string) =>
		call('/api/flow.next', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Accept: 'text/html' },
			body: JSON.stringify({ to }),
			redirect: 'manual',
		})

	test.each(['/thanks', '/search?q=a%20b#top', 'https://partner.example/welcome'])('%s is answered as a redirect', async (to) => {
		const response = await redirectTo(to)
		expect(response.status).toBe(303)
		expect(response.headers.get('Location')).toBe(to)
	})

	test.each([
		'/\t/elsewhere.example/p',
		'/\t\t/elsewhere.example/p',
		'/\n/elsewhere.example/p',
		'/\r/elsewhere.example/p',
		'//elsewhere.example/p',
		'/\\elsewhere.example/p',
		'https://elsewhere.example/p',
		'thanks',
	])('%j fails the invocation and sets no Location', async (to) => {
		const response = await redirectTo(to)
		expect(response.status).toBe(500)
		expect(response.headers.get('Location')).toBeNull()
	})
})
