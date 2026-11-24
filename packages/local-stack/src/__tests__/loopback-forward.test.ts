import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { parseLoopbackArgs, startLoopbackForwards } from '../loopback-forward'

const freePort = async (): Promise<number> => {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen({ host: '127.0.0.1', port: 0 }, resolve))
	const address = server.address()
	await new Promise<void>((resolve) => server.close(() => resolve()))
	if (address === null || typeof address === 'string') throw new Error('no port')
	return address.port
}

describe('the loopback forward arguments', () => {
	test('name each forward, then the command', () => {
		expect(parseLoopbackArgs(['18080=platform-proxy-auth:18080', '18081=apps-proxy-auth:18081', '--', 'sh', '-c', 'exec bun x.ts'])).toEqual({
			forwards: [
				{ port: 18080, host: 'platform-proxy-auth', targetPort: 18080 },
				{ port: 18081, host: 'apps-proxy-auth', targetPort: 18081 },
			],
			command: ['sh', '-c', 'exec bun x.ts'],
		})
	})

	test('refuse a target Bun would send back to loopback, a missing command and a port forwarded twice', () => {
		expect(() => parseLoopbackArgs(['18080=iam.fabrika.localhost:18080', '--', 'bun'])).toThrow('is not <port>=<service>:<port>')
		expect(() => parseLoopbackArgs(['18080=iam:18080'])).toThrow('usage')
		expect(() => parseLoopbackArgs(['18080=iam:18080', '--'])).toThrow('no command')
		expect(() => parseLoopbackArgs(['18080=iam:70000', '--', 'bun'])).toThrow('is not a port')
		expect(() => parseLoopbackArgs(['1=a:1', '1=b:2', '--', 'bun'])).toThrow('forwarded twice')
	})
})

describe('a loopback forward', () => {
	const servers: Server[] = []
	afterEach(() => {
		for (const server of servers.splice(0)) server.close()
	})

	test("carries Bun's fetch of a *.localhost name to the service it names", async () => {
		const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new Response(`upstream saw ${new URL(request.url).host}`) })
		try {
			const port = await freePort()
			servers.push(...(await startLoopbackForwards([{ port, host: '127.0.0.1', targetPort: upstream.port ?? 0 }])))
			const response = await fetch(`http://iam.fabrika.localhost:${port}/healthz`)
			expect(response.status).toBe(200)
			expect(await response.text()).toBe(`upstream saw iam.fabrika.localhost:${port}`)
		} finally {
			await upstream.stop(true)
		}
	})
})
