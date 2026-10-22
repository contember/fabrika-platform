import { createWebSocketManager, SessionManager, type WSData } from '@fabrika/canvas-kernel/server'
import { corsHeaders, dispatch, jsonResponse } from '@fabrika/daemon-kit'
import { randomBytes } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { createApiHandlers } from './handlers/api'
import { createFileHandlers } from './handlers/files'
import { createStaticHandlers } from './handlers/static'
import { createUploadHandlers } from './handlers/uploads'
import { CLI_AUTH_FILE, PID_FILE, REVIEWS_DIR, SESSIONS_DIR, TEMP_DIR } from './paths'
import { startRemoteFeedbackPoller } from './remote-feedback'
import { ReviewProxies } from './review/proxy'
import { createReviewServer, type ReviewSocketData } from './review/server'
import { ReviewStore } from './review/store'

const PORT = parseInt(process.env.CANVAS_PORT || '19400', 10)
const VERSION = JSON.parse(readFileSync(join(dirname(import.meta.dir), '..', 'package.json'), 'utf-8')).version as string

// Write PID file so CLI can find and stop us
mkdirSync(TEMP_DIR, { recursive: true, mode: 0o700 })
chmodSync(TEMP_DIR, 0o700)
writeFileSync(PID_FILE, String(process.pid))
const cliAuthToken = randomBytes(32).toString('base64url')
writeFileSync(CLI_AUTH_FILE, cliAuthToken, { mode: 0o600 })
chmodSync(CLI_AUTH_FILE, 0o600)

const sessionManager = new SessionManager(SESSIONS_DIR)
const wsManager = createWebSocketManager(sessionManager)
const reviewStore = new ReviewStore(REVIEWS_DIR)
const reviewProxies = new ReviewProxies(reviewStore, `http://localhost:${PORT}/assets/review.js`, (project, path) => review.fullReload(project, path))
const review = createReviewServer(reviewStore, reviewProxies)

type SocketData = WSData | ReviewSocketData
type Socket = Bun.ServerWebSocket<SocketData>

function isReviewSocket(socket: Socket): socket is Bun.ServerWebSocket<ReviewSocketData> {
	return socket.data.type === 'review'
}

function isCanvasSocket(socket: Socket): socket is Bun.ServerWebSocket<WSData> {
	return socket.data.type !== 'review'
}

const routes = [
	...createApiHandlers({
		sessionManager,
		broadcastPlanUpdate: wsManager.broadcastPlanUpdate,
		broadcastRevisionUpdate: wsManager.broadcastRevisionUpdate,
		port: PORT,
		version: VERSION,
		cliAuthToken,
	}),
	...createFileHandlers(sessionManager),
	...createUploadHandlers(sessionManager),
	...createStaticHandlers(),
]

const server = Bun.serve<SocketData>({
	port: PORT,
	hostname: 'localhost',
	fetch(req, server) {
		const url = new URL(req.url)

		// Review mode answers its own preflights: the application under review runs on another port.
		const reviewResponse = review.fetch(req, url, server)
		if (reviewResponse === 'upgraded') return undefined
		if (reviewResponse !== null) return reviewResponse

		// CORS preflight
		if (req.method === 'OPTIONS') {
			return new Response(null, { status: 204, headers: corsHeaders(PORT) })
		}

		// WebSocket upgrade: /ws/session/:id
		const wsBrowserMatch = url.pathname.match(/^\/ws\/session\/([^/]+)$/)
		if (wsBrowserMatch) {
			const upgraded = server.upgrade(req, { data: { type: 'browser', sessionId: wsBrowserMatch[1] } })
			if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
			return undefined
		}

		// WebSocket upgrade: /ws/wait/:id
		const wsWaitMatch = url.pathname.match(/^\/ws\/wait\/([^/]+)$/)
		if (wsWaitMatch) {
			const upgraded = server.upgrade(req, { data: { type: 'wait', sessionId: wsWaitMatch[1] } })
			if (!upgraded) return new Response('WebSocket upgrade failed', { status: 400 })
			return undefined
		}

		// Route dispatch
		const response = dispatch(routes, req, url)
		if (response) return response

		// Root redirect
		if (url.pathname === '/' && req.method === 'GET') {
			const sessions = sessionManager.list()
			if (sessions.length > 0) {
				const latest = sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]
				return Response.redirect(`/s/${latest.id}`, 302)
			}
			return jsonResponse({ message: 'No active sessions', sessions: [] })
		}

		return jsonResponse({ error: 'Not found' }, 404)
	},

	websocket: {
		open(socket) {
			if (isReviewSocket(socket)) review.channel.handlers.open(socket)
			else if (isCanvasSocket(socket)) wsManager.handlers.open(socket)
		},
		message(socket, message) {
			if (isReviewSocket(socket)) review.channel.handlers.message(socket, message)
			else if (isCanvasSocket(socket)) wsManager.handlers.message(socket, message)
		},
		pong(socket) {
			if (isReviewSocket(socket)) review.channel.handlers.pong(socket)
			else if (isCanvasSocket(socket)) wsManager.handlers.pong(socket)
		},
		close(socket) {
			if (isReviewSocket(socket)) review.channel.handlers.close(socket)
			else if (isCanvasSocket(socket)) wsManager.handlers.close(socket)
		},
	},
})

export { server, sessionManager }
export const broadcastPlanUpdate = wsManager.broadcastPlanUpdate

// Start polling for remote feedback from shared canvases.
// No-ops if CANVAS_SHARE_ENDPOINT is not set.
startRemoteFeedbackPoller(sessionManager, wsManager.broadcastRemoteFeedback, VERSION)

reviewProxies.restore()

console.log(`Planner daemon listening on http://localhost:${PORT}`)
