// ctx.signal of a request handler: it aborts when the request is cancelled or outlives its budget, so an outbound call
// the handler passes it to stops with the request instead of running on after the client left.

import { defineApp, defineVocabulary } from '@fabrika/app/contract'
import { serve } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod/v4'
import { handlerSignal } from '../implement/bounded'

const vocabulary = defineVocabulary({
	app: 'signals',
	dimensions: { project: {} },
	actions: { 'projects.read': 'Read projects' },
	roles: { reader: { grants: ['projects.read'] } },
})
const app = defineApp(vocabulary)
const Called = z.strictObject({ status: z.int() })

/** What the handler saw of its signal after its outbound call ended. */
const seen = { aborted: false, reason: '' }

/** A provider that holds every request until its caller gives up, and says when one reached it and when it was dropped. */
const upstream = (() => {
	const reached = Promise.withResolvers<void>()
	const dropped = Promise.withResolvers<void>()
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			reached.resolve()
			await new Promise<void>((resolve) => request.signal.addEventListener('abort', () => resolve(), { once: true }))
			dropped.resolve()
			return new Response(null, { status: 204 })
		},
	})
	return {
		url: `http://127.0.0.1:${server.port}/send`,
		reached: reached.promise,
		dropped: dropped.promise,
		stop: () => server.stop(true),
	}
})()

afterAll(() => upstream.stop())

const projects = app.group({ callers: ['human'] }, (r) => ({
	call: r.mutation({ output: Called, access: { action: 'projects.read', over: 'project' } })
		.handle(async ({ ctx }) => {
			try {
				const response = await fetch(upstream.url, { method: 'POST', signal: ctx.signal })
				return { status: response.status }
			} finally {
				seen.aborted = ctx.signal.aborted
				seen.reason = ctx.signal.aborted ? String(Reflect.get(Object(ctx.signal.reason), 'name')) : ''
			}
		}),
}))
const contract = app.contract((c) => ({ api: c.rpc('/api', { projects }), health: c.health('/healthz') }))

describe('ctx.signal of a request handler', () => {
	test('a cancelled request aborts it, and the fetch the handler passed it to stops at the provider', async () => {
		// The provider was reached, so the signal was live until the cancel.
		const kit = testKit(serve(contract, { database: null }))
		const reader = kit.testCaller([{ action: 'projects.read', scope: { type: 'project', value: 'p1' } }])
		const cancel = new AbortController()
		const log = spyOn(console, 'error').mockImplementation(() => {})
		try {
			const answer = kit.browser(reader)('/api/projects.call', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
				signal: cancel.signal,
			}).catch(() => null)
			await upstream.reached
			cancel.abort()
			await upstream.dropped
			await answer
		} finally {
			log.mockRestore()
		}
		expect(seen).toEqual({ aborted: true, reason: 'AbortError' })
	})

	test('the budget aborts it when the request runs too long, with a TimeoutError', async () => {
		const signal = handlerSignal(new Request('https://signals.test/api/projects.call'), 20)
		expect(signal.aborted).toBe(false)
		await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
		expect(String(Reflect.get(Object(signal.reason), 'name'))).toBe('TimeoutError')
	})
})
