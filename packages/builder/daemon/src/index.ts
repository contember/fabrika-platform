import { createWebSocketManager, SessionManager, unwatchAll, type WSData } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { resolve } from 'path'
import { BUILDER_DAEMON_HOST } from '../../shared/urls'
import { admitRequest } from './admission'
import { BuildStream } from './build-stream'
import { createHandlers } from './handlers'
import { SESSIONS_DIR } from './paths'
import { BuilderPlatform, type BuilderPlatformOptions } from './platform'
import { createPlatformRoutes } from './platform-routes'
import { createStaticHandlers } from './static'

export { type Phase, type PhaseId, PHASES } from '../../shared/phases'
export type { BuildEvent } from './build-stream'
export { derivePhaseState, type PhaseState } from './phases'

export interface GateRecord {
	name: string
	revision: number
	hasFeedback: boolean
	consumed: boolean
}

const DEFAULT_PORT = parseInt(process.env['FABRIKA_PORT'] || '19410', 10)
const VERSION = '0.0.0'

export interface StartDaemonOptions {
	port?: number
	sessionsDir?: string
	platform?: BuilderPlatformOptions
}

export interface RunningDaemon {
	server: import('bun').Server<WSData>
	port: number
	sessionManager: SessionManager
	stop(): void
}

export function startDaemon(opts: StartDaemonOptions = {}): RunningDaemon {
	const port = opts.port ?? DEFAULT_PORT

	const sessionsDir = resolve(opts.sessionsDir ?? SESSIONS_DIR)
	const sessionManager = new SessionManager(sessionsDir)
	sessionManager.cleanupStale()
	const wsManager = createWebSocketManager(sessionManager, { feedbackConsumption: 'external' })
	const buildStream = new BuildStream()
	const platform = new BuilderPlatform((id) => sessionManager.get(id)?.projectRoot, opts.platform)

	const portRef = { value: port }

	const handlerCtx = {
		sessionManager,
		broadcastPlanUpdate: wsManager.broadcastPlanUpdate,
		broadcastRevisionUpdate: wsManager.broadcastRevisionUpdate,
		buildStream,
		platform,
		sessionsDir,
		get port() {
			return portRef.value
		},
		version: VERSION,
	}

	const routes = [...createPlatformRoutes(platform), ...createHandlers(handlerCtx), ...createStaticHandlers()]

	const server = Bun.serve<WSData>({
		port,
		hostname: BUILDER_DAEMON_HOST,
		fetch(req, server) {
			const url = new URL(req.url)
			const rejection = admitRequest(req, url, portRef.value)
			if (rejection) return rejection

			if (req.method === 'OPTIONS') {
				return new Response(null, { status: 204 })
			}

			const wsBrowser = url.pathname.match(/^\/ws\/session\/([^/]+)$/)
			if (wsBrowser) {
				const ok = server.upgrade(req, { data: { type: 'browser', sessionId: wsBrowser[1]! } })
				if (!ok) return new Response('WebSocket upgrade failed', { status: 400 })
				return
			}

			const wsWait = url.pathname.match(/^\/ws\/wait\/([^/]+)$/)
			if (wsWait) {
				const ok = server.upgrade(req, { data: { type: 'wait', sessionId: wsWait[1]! } })
				if (!ok) return new Response('WebSocket upgrade failed', { status: 400 })
				return
			}

			const response = dispatch(routes, req, url)
			if (response) return response

			if (url.pathname === '/' && req.method === 'GET') {
				const sessions = sessionManager.list()
				if (sessions.length > 0) {
					const latest = sessions.sort(
						(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
					)[0]!
					return Response.redirect(`/s/${latest.id}`, 302)
				}
				return new Response(JSON.stringify({ message: 'No active sessions', sessions: [] }), {
					headers: { 'Content-Type': 'application/json' },
				})
			}

			return new Response(JSON.stringify({ error: 'Not found' }), {
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			})
		},
		websocket: wsManager.handlers,
	})

	const boundPort = server.port ?? port
	portRef.value = boundPort

	return {
		server,
		port: boundPort,
		sessionManager,
		stop() {
			platform.stop()
			try {
				unwatchAll()
			} catch {
			}
			server.stop(true)
		},
	}
}
