// Since Bun 1.4.1, fetch, WebSocket and Bun.connect send every `*.localhost` name to the container's own loopback, past
// the network aliases; this entrypoint forwards loopback ports to the proxies that serve those names, then runs the
// command. `node:net` still uses the system resolver, so a target is a plain service name.

import { connect, createServer, type Server } from 'node:net'

export interface LoopbackForward {
	readonly port: number
	readonly host: string
	readonly targetPort: number
}

const FORWARD = /^(\d{1,5})=([a-z0-9][a-z0-9-]*):(\d{1,5})$/
const LOOPBACK_HOSTS = ['127.0.0.1', '::1'] as const

const portNumber = (text: string, spec: string): number => {
	const port = Number(text)
	if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`loopback forward ${spec}: ${text} is not a port`)
	return port
}

/** `<port>=<service>:<port>` items, `--`, then the command. A target has no dot, so it cannot be a `.localhost` name. */
export function parseLoopbackArgs(args: readonly string[]): { readonly forwards: readonly LoopbackForward[]; readonly command: readonly string[] } {
	const separator = args.indexOf('--')
	if (separator === -1) throw new Error('usage: loopback-forward.ts <port>=<service>:<port>… -- <command…>')
	const command = args.slice(separator + 1)
	if (command.length === 0) throw new Error('loopback-forward.ts: no command after --')
	const forwards = args.slice(0, separator).map((spec) => {
		const match = FORWARD.exec(spec)
		if (match === null) throw new Error(`loopback forward ${spec} is not <port>=<service>:<port>`)
		const [, port = '', host = '', targetPort = ''] = match
		return { port: portNumber(port, spec), host, targetPort: portNumber(targetPort, spec) }
	})
	const ports = new Set(forwards.map((forward) => forward.port))
	if (ports.size !== forwards.length) throw new Error('loopback-forward.ts: a port is forwarded twice')
	return { forwards, command }
}

const errorCode = (error: Error): string | undefined => ('code' in error && typeof error.code === 'string' ? error.code : undefined)

// A container without IPv6 has no ::1 (or no IPv6 at all); IPv4 loopback alone still serves the forward.
const NO_IPV6 = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])

const listen = (server: Server, host: string, port: number): Promise<boolean> =>
	new Promise((resolve, reject) => {
		server.once('error', (error) => {
			if (host === '::1' && NO_IPV6.has(errorCode(error) ?? '')) resolve(false)
			else reject(error)
		})
		server.listen({ host, port }, () => resolve(true))
	})

/** Listen on both loopback addresses of each forward; each connection is piped to its target with backpressure. */
export async function startLoopbackForwards(forwards: readonly LoopbackForward[]): Promise<readonly Server[]> {
	const servers: Server[] = []
	for (const forward of forwards) {
		for (const host of LOOPBACK_HOSTS) {
			const server = createServer((client) => {
				const upstream = connect({ host: forward.host, port: forward.targetPort })
				client.on('error', () => upstream.destroy())
				upstream.on('error', (error) => {
					console.warn(`loopback :${forward.port} cannot reach ${forward.host}:${forward.targetPort} (${errorCode(error) ?? 'error'})`)
					client.destroy()
				})
				client.pipe(upstream).pipe(client)
			})
			if (await listen(server, host, forward.port)) servers.push(server)
		}
	}
	return servers
}

if (import.meta.main) {
	const { forwards, command } = parseLoopbackArgs(Bun.argv.slice(2))
	await startLoopbackForwards(forwards)
	const child = Bun.spawn([...command], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
	for (const signal of ['SIGTERM', 'SIGINT'] as const) process.on(signal, () => child.kill(signal))
	process.exit(await child.exited)
}
