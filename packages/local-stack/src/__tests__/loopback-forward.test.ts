import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { z } from 'zod'
import { parseLoopbackArgs, startLoopbackForwards } from '../loopback-forward'
import { LOCAL_PORTS } from '../ports'
import { readComposeFile } from './compose-file'

const composeSchema = z.object({
	services: z.record(
		z.object({
			entrypoint: z.array(z.string()).optional(),
			networks: z.union([z.array(z.string()), z.record(z.unknown())]).optional(),
			network_mode: z.string().optional(),
		}),
	),
})

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

describe('the composition', () => {
	const FORWARDER = '/workspace/packages/local-stack/src/loopback-forward.ts'

	test('starts every container that calls a public host through the forwarder, aimed at a proxy it already reaches', async () => {
		const { services } = composeSchema.parse(Bun.YAML.parse(await readComposeFile('compose.yaml')))
		const networks = (name: string): ReadonlySet<string> => {
			const declared = services[name]?.networks
			return new Set(declared === undefined ? [] : Array.isArray(declared) ? declared : Object.keys(declared))
		}
		const forwarding = Object.entries(services).filter(([, service]) => service.entrypoint?.[1] === FORWARDER)
		expect(forwarding.map(([name]) => name).sort()).toEqual(['apps-proxy-auth', 'control', 'iam', 'notes', 'operations'])
		for (const [name, service] of forwarding) {
			const { forwards } = parseLoopbackArgs([...(service.entrypoint ?? []).slice(2), 'true'])
			for (const forward of forwards) {
				// Each public port is served by the proxy pair whose auth container holds its network namespace.
				expect(`${forward.port}=${forward.host}:${forward.targetPort}`).toBeOneOf([
					`${LOCAL_PORTS.platform}=platform-proxy-auth:${LOCAL_PORTS.platform}`,
					`${LOCAL_PORTS.apps}=apps-proxy-auth:${LOCAL_PORTS.apps}`,
				])
				expect([...networks(name)].some((network) => networks(forward.host).has(network)), `${name} → ${forward.host}`).toBe(true)
			}
		}
	})
})
