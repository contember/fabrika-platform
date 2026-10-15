// `FabrikaProvider` reports the page's errors by itself: it reads the mount's browser config, and with a DSN every
// uncaught error reaches the ingest. `reportErrors={false}` reads nothing, and an unmounted provider reports nothing.

import { mount, settle } from './dom'

import { createClient, type RpcFetch } from '@fabrika/app/client'
import { defineContract } from '@fabrika/app/contract'
import { describe, expect, test } from 'bun:test'
import { z } from 'zod/v4'
import { FabrikaProvider } from '../provider'

const contract = defineContract({ app: 'notes', dimensions: {}, actions: { 'notes.read': 'Read notes' }, roles: {} }, (c) => ({
	api: c.rpc('/api', { callers: ['human'] }, { me: c.query({ output: z.strictObject({ id: z.string() }), access: { member: true } }) }),
	web: c.spa('/app', { dir: 'dist/app', access: { member: true } }),
}))
const api = createClient(contract, 'api', { fetch: () => Promise.reject(new Error('the page calls nothing')) })

const DSN = 'https://0123456789abcdef0123456789abcdef@errors.example/42'

const recorder = () => {
	const requests: string[] = []
	const fetch: RpcFetch = async (input) => {
		const url = String(input)
		requests.push(url)
		return url.endsWith('__fabrika-config.json')
			? Response.json({ dsn: DSN, release: 'fabrika/notes/prod/default/abc', environment: 'prod' })
			: new Response(null, { status: 202 })
	}
	return { requests, fetch }
}

const throwUncaught = async (message: string): Promise<void> => {
	window.dispatchEvent(new ErrorEvent('error', { error: new Error(message), message }))
	await settle()
}

describe('the provider reports the page errors', () => {
	test('from the browser config of its mount, without the application asking', async () => {
		const { requests, fetch } = recorder()
		const page = await mount(<FabrikaProvider clients={[api]} spa="/app" fetch={fetch} />)
		await settle()
		expect(requests).toEqual(['/app/__fabrika-config.json'])

		await throwUncaught('boom')
		expect(requests.slice(1)).toEqual(['https://errors.example/api/42/envelope/?sentry_key=0123456789abcdef0123456789abcdef&sentry_version=7'])

		await page.unmount()
		await throwUncaught('after the page left')
		expect(requests).toHaveLength(2)
	})

	test('an application that opts out reads no config and reports nothing', async () => {
		const { requests, fetch } = recorder()
		const page = await mount(<FabrikaProvider clients={[api]} spa="/app" fetch={fetch} reportErrors={false} />)
		await settle()
		await throwUncaught('boom')
		expect(requests).toEqual([])
		await page.unmount()
	})
})
