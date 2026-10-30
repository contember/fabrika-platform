// The relay `zbox-router.live.test.ts` sends its router requests through. A sandbox cannot reach the router of the
// host it runs on, so the requests have to leave from another service in the Box's project, as the proxy's do.
//
// Run it as any Bun service in that project, with a public subdomain on its port 8080 and a random RELAY_TOKEN:
//
//   RELAY_TOKEN=<random> bun router-relay.ts
//
// `POST /` with `Authorization: Bearer <RELAY_TOKEN>` and `{ address, host, headers }` sends one raw HTTP/1.1 GET to
// `address` (`host:port`), so that nothing adds or rewrites a header, and answers `{ status, body }`, or 502 when it
// could not connect. It has no dependencies, so the file alone is the deployment.

const token = process.env['RELAY_TOKEN'] ?? ''
if (token.length < 16) throw new Error('router-relay: set RELAY_TOKEN to a random value of at least 16 characters')

const CONNECT_TIMEOUT_MS = 10_000

function decodeChunked(body: string): string {
	let decoded = ''
	let rest = body
	while (rest.length > 0) {
		const end = rest.indexOf('\r\n')
		const size = Number.parseInt(rest.slice(0, end), 16)
		if (!(size > 0)) break
		decoded += rest.slice(end + 2, end + 2 + size)
		rest = rest.slice(end + 4 + size)
	}
	return decoded
}

async function send(address: string, host: string, headers: readonly string[]): Promise<{ status: number; body: string }> {
	const [hostname = '', port = ''] = address.split(':')
	const request = ['GET /probe HTTP/1.1', `Host: ${host}`, 'Connection: close', ...headers, '', ''].join('\r\n')
	const text = await new Promise<string>((resolve, reject) => {
		let received = ''
		const timer = setTimeout(() => reject(new Error('timed out')), CONNECT_TIMEOUT_MS)
		Bun.connect({
			hostname,
			port: Number(port),
			socket: {
				open: (socket) => {
					socket.write(request)
				},
				data: (_socket, chunk) => {
					received += new TextDecoder().decode(chunk)
				},
				close: () => {
					clearTimeout(timer)
					resolve(received)
				},
				error: (_socket, error) => reject(error),
				connectError: (_socket, error) => reject(error),
			},
		}).catch(reject)
	})
	const [head = '', ...rest] = text.split('\r\n\r\n')
	const body = rest.join('\r\n\r\n')
	return { status: Number(head.split(' ')[1]), body: /^transfer-encoding:\s*chunked/im.test(head) ? decodeChunked(body) : body }
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

Bun.serve({
	port: 8080,
	fetch: async (request) => {
		if (request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${token}`) return new Response(null, { status: 404 })
		const input: unknown = await request.json()
		if (
			typeof input !== 'object' || input === null || !('address' in input) || typeof input.address !== 'string' || !('host' in input)
			|| typeof input.host !== 'string' || !('headers' in input) || !isStringArray(input.headers)
		) {
			return new Response(null, { status: 400 })
		}
		try {
			return Response.json(await send(input.address, input.host, input.headers))
		} catch {
			return new Response(null, { status: 502 })
		}
	},
})
