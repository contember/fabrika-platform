import { createWebSocketManager, SessionManager, unwatchAll, type WSData } from '@fabrika/canvas-kernel/server'
import { dispatch } from '@fabrika/daemon-kit'
import { resolve } from 'path'
import { BuildStream } from './build-stream'
import { corsHeaders, createHandlers } from './handlers'
import { SESSIONS_DIR } from './paths'
import { createStaticHandlers } from './static'

export type { BuildEvent } from './build-stream'
export { derivePhaseState, PHASES } from './phases'
export type { Phase, PhaseId, PhaseState } from './phases'

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

	const portRef = { value: port }

	const handlerCtx = {
		sessionManager,
		broadcastPlanUpdate: wsManager.broadcastPlanUpdate,
		broadcastRevisionUpdate: wsManager.broadcastRevisionUpdate,
		buildStream,
		sessionsDir,
		get port() {
			return portRef.value
		},
		version: VERSION,
	}

	const routes = [...createHandlers(handlerCtx), ...createStaticHandlers()]

	const server = Bun.serve<WSData>({
		port,
		hostname: 'localhost',
		fetch(req, server) {
			const url = new URL(req.url)

			if (req.method === 'OPTIONS') {
				return new Response(null, { status: 204, headers: corsHeaders(portRef.value) })
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
			try {
				unwatchAll()
			} catch {
			}
			server.stop(true)
		},
	}
}
