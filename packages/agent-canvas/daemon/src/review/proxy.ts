import { z } from 'zod'
import type { ReviewStore } from './store'

/** Vite's hot reload message that makes its client reload the page. */
const viteFullReloadSchema = z.object({ type: z.literal('full-reload'), path: z.string().default('*') })

/** The page path a Vite full reload names, or `undefined` for any other frame. */
export function viteFullReloadPath(frame: string): string | undefined {
	if (!frame.includes('full-reload')) return undefined
	let message: unknown
	try {
		message = JSON.parse(frame)
	} catch {
		return undefined
	}
	const parsed = viteFullReloadSchema.safeParse(message)
	return parsed.success ? parsed.data.path : undefined
}

/** One browser socket proxied to the application, e.g. its dev server's hot reload. */
interface ProxySocketData {
	upstream: WebSocket
	/** Frames the application sent before the browser's socket opened. */
	early: Array<string | ArrayBuffer>
	browser: Bun.ServerWebSocket<ProxySocketData> | null
}

type ProxyServer = Bun.Server<ProxySocketData>

interface RunningProxy {
	target: string
	server: ProxyServer
}

/** Puts the widget's tag before `</body>`, or at the end of a document without one. */
export function withWidget(html: string, tag: string): string {
	const bodyEnd = html.toLowerCase().lastIndexOf('</body>')
	return bodyEnd === -1 ? `${html}${tag}` : `${html.slice(0, bodyEnd)}${tag}${html.slice(bodyEnd)}`
}

function connectUpstream(url: URL, protocols: string[]): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(url, protocols)
		socket.binaryType = 'arraybuffer'
		socket.onopen = () => resolve(socket)
		socket.onerror = () => reject(new Error(`WebSocket ${url} failed`))
	})
}

/**
 * Review proxies: each project's application, served on a port of its own with the review widget added to every HTML
 * page, so a reviewer opens a URL instead of editing the application. The proxy's origin is a loopback one, which the
 * review routes accept; it forwards to applications on this machine only.
 */
export class ReviewProxies {
	private readonly running = new Map<string, RunningProxy>()

	/**
	 * `onFullReload` receives the full reloads the application's dev server asks for: the proxy holds them back from
	 * the page, so a reload does not take the comment the reviewer is writing.
	 */
	constructor(
		private readonly store: ReviewStore,
		private readonly widgetScript: string,
		private readonly onFullReload: (project: string, path: string) => void,
	) {}

	/** Serves the project's application at `target` and returns where the reviewer opens it, `target`'s path kept. */
	open(project: string, target: string): string {
		const targetUrl = new URL(target)
		const current = this.running.get(project)
		if (current === undefined || current.target !== targetUrl.origin) {
			const port = current?.server.port ?? this.store.proxyOf(project)?.port
			current?.server.stop(true)
			this.listen(project, targetUrl.origin, port)
		}
		const proxy = this.running.get(project)
		if (proxy === undefined) throw new Error(`Review proxy for ${project} did not start`)
		return `http://localhost:${proxy.server.port}${targetUrl.pathname}${targetUrl.search}${targetUrl.hash}`
	}

	/** Serves every proxy a previous daemon served, on the same ports. */
	restore(): void {
		for (const project of this.store.proxiedProjects()) {
			try {
				const proxy = this.store.proxyOf(project)
				if (proxy !== undefined) this.listen(project, proxy.target, proxy.port)
			} catch (error) {
				console.error(`Review proxy for ${project} not restored: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	stop(): void {
		for (const proxy of this.running.values()) proxy.server.stop(true)
		this.running.clear()
	}

	private listen(project: string, target: string, port: number | undefined): void {
		let server: ProxyServer
		try {
			server = this.serve(project, target, port ?? 0)
		} catch (error) {
			if (port === undefined) throw error
			// The previous port is taken; the reviewer opens the new URL the CLI prints.
			server = this.serve(project, target, 0)
		}
		this.running.set(project, { target, server })
		this.store.saveProxy(project, { target, port: server.port ?? 0 })
	}

	private serve(project: string, target: string, port: number): ProxyServer {
		const widgetTag = `<script src="${this.widgetScript}" data-project="${project}"></script>`
		return Bun.serve<ProxySocketData>({
			port,
			hostname: 'localhost',
			fetch: async (req, server) => {
				const url = new URL(req.url)
				const upstreamUrl = new URL(`${url.pathname}${url.search}`, target)
				if (req.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
					upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
					return await this.upgrade(project, req, server, upstreamUrl)
				}
				return await forward(req, upstreamUrl, url.origin, widgetTag)
			},
			websocket: {
				open(socket) {
					socket.data.browser = socket
					for (const frame of socket.data.early) socket.send(frame)
					socket.data.early = []
					if (socket.data.upstream.readyState !== WebSocket.OPEN) socket.close()
				},
				message(socket, message) {
					if (socket.data.upstream.readyState === WebSocket.OPEN) socket.data.upstream.send(message)
				},
				close(socket) {
					socket.data.upstream.close()
				},
			},
		})
	}

	/** Connects to the application first, so the browser gets the subprotocol the application chose. */
	private async upgrade(project: string, req: Request, server: ProxyServer, upstreamUrl: URL): Promise<Response | undefined> {
		const protocols = (req.headers.get('Sec-WebSocket-Protocol') ?? '').split(',').map((protocol) => protocol.trim()).filter((protocol) =>
			protocol !== ''
		)
		let upstream: WebSocket
		try {
			upstream = await connectUpstream(upstreamUrl, protocols)
		} catch {
			return new Response('agent-canvas review: the application refused the WebSocket', { status: 502 })
		}
		const data: ProxySocketData = { upstream, early: [], browser: null }
		upstream.onmessage = (event) => {
			if (typeof event.data !== 'string' && !(event.data instanceof ArrayBuffer)) return
			const reloadPath = typeof event.data === 'string' ? viteFullReloadPath(event.data) : undefined
			if (reloadPath !== undefined) return this.onFullReload(project, reloadPath)
			if (data.browser === null) data.early.push(event.data)
			else data.browser.send(event.data)
		}
		upstream.onclose = () => data.browser?.close()
		// Bun rejects an empty `headers` object, so a socket without a subprotocol (Bun's own hot reload) passes none.
		const upgraded = upstream.protocol === ''
			? server.upgrade(req, { data })
			: server.upgrade(req, { data, headers: { 'Sec-WebSocket-Protocol': upstream.protocol } })
		if (upgraded) return undefined
		upstream.close()
		return new Response('WebSocket upgrade failed', { status: 400 })
	}
}

async function forward(req: Request, upstreamUrl: URL, proxyOrigin: string, widgetTag: string): Promise<Response> {
	const headers = new Headers(req.headers)
	headers.delete('Host')
	// Uncompressed, so an HTML page can take the widget's tag.
	headers.set('Accept-Encoding', 'identity')
	if (headers.get('Origin') === proxyOrigin) headers.set('Origin', upstreamUrl.origin)
	let upstream: Response
	try {
		upstream = await fetch(upstreamUrl, {
			method: req.method,
			headers,
			body: req.method === 'GET' || req.method === 'HEAD' ? null : req.body,
			redirect: 'manual',
		})
	} catch {
		return new Response(`agent-canvas review: ${upstreamUrl.origin} does not answer. Is the application running?`, {
			status: 502,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		})
	}

	const responseHeaders = new Headers(upstream.headers)
	// fetch hands over a decoded body, whatever the application sent.
	responseHeaders.delete('Content-Encoding')
	responseHeaders.delete('Content-Length')
	const location = responseHeaders.get('Location')
	if (location?.startsWith(upstreamUrl.origin)) responseHeaders.set('Location', `${proxyOrigin}${location.slice(upstreamUrl.origin.length)}`)

	const init = { status: upstream.status, statusText: upstream.statusText, headers: responseHeaders }
	if (req.method === 'HEAD' || !(responseHeaders.get('Content-Type') ?? '').startsWith('text/html')) return new Response(upstream.body, init)
	return new Response(withWidget(await upstream.text(), widgetTag), init)
}
