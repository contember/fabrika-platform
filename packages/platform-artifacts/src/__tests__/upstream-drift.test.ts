import { expect, test } from 'bun:test'
import { checkUpstreamSchemas, driftExitCode, SCHEMA_SOURCES } from '../../schemas/check'

test('unchanged JSON ignores formatting and object key order', async () => {
	const urls: string[] = []
	const results = await checkUpstreamSchemas({
		readPinned: async () => '{"type":"object","properties":{}}',
		fetch: async (url) => {
			urls.push(url)
			return Response.json({ properties: {}, type: 'object' })
		},
	})
	expect(urls).toEqual(Object.values(SCHEMA_SOURCES))
	expect(results.map((result) => result.status)).toEqual(['unchanged', 'unchanged'])
	expect(driftExitCode(results)).toBe(0)
})
test('changed upstream contracts are reported without updating the pin', async () => {
	const results = await checkUpstreamSchemas({ readPinned: async () => '{"type":"integer"}', fetch: async () => Response.json({ type: 'string' }) })
	expect(results.map((result) => result.status)).toEqual(['changed', 'changed'])
	expect(driftExitCode(results)).toBe(1)
})
test('network, HTTP and unreadable responses are unavailable, not drift', async () => {
	for (
		const fetch of [
			async () => {
				throw new Error('offline')
			},
			async () => new Response('', { status: 503 }),
			async () => new Response('<html>'),
		]
	) {
		const results = await checkUpstreamSchemas({ readPinned: async () => '{}', fetch })
		expect(results.map((result) => result.status)).toEqual(['unavailable', 'unavailable'])
		expect(driftExitCode(results)).toBe(2)
	}
})
test('unavailable takes precedence over drift while retaining both results', async () => {
	let count = 0
	const results = await checkUpstreamSchemas({
		readPinned: async () => '{}',
		fetch: async () => ++count === 1 ? Response.json({ changed: true }) : new Response('', { status: 500 }),
	})
	expect(results.map((result) => result.status)).toEqual(['changed', 'unavailable'])
	expect(driftExitCode(results)).toBe(2)
})
