import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const TEMP_DIR = join(tmpdir(), 'fabrika')
export const PID_FILE = join(TEMP_DIR, 'daemon.pid')

export interface DiffStats {
	added: number
	removed: number
}
export interface CanvasFileInfo {
	filename: string
	diffStats?: DiffStats
}
export type CanvasScope =
	| { kind: 'view'; filename: string }
	| { kind: 'directory' }
export interface RevisionInfo {
	revision: number
	label?: string
	canvasFiles: CanvasFileInfo[]
	createdAt: string
	hasFeedback: boolean
	feedbackConsumed: boolean
	response?: string
	canvasScope?: CanvasScope
}
export interface SessionData {
	id: string
	projectRoot: string
	canvasFiles: string[]
	currentRevision: number
	revisions: RevisionInfo[]
	createdAt: string
	updatedAt: string
}
export type CompileResult = { ok: true; js: string } | { ok: false; error: string }
export type WSData = { type: 'browser' | 'wait'; sessionId: string }

export type RouteHandler = (req: Request, url: URL, match: URLPatternResult) => Response | Promise<Response>
export interface Route {
	method: string
	pattern: URLPattern
	handler: RouteHandler
}

export async function compileJsx(jsx: string, _projectRoot?: string): Promise<CompileResult> {
	if (jsx.includes('@@FAIL@@')) return { ok: false, error: 'forced failure' }
	return { ok: true, js: `/* compiled */ export default ${JSON.stringify(jsx)};` }
}
export const compilePlan = compileJsx

export function dispatch(routes: Route[], req: Request, url: URL): Response | Promise<Response> | null {
	for (const route of routes) {
		if (route.method !== req.method) continue
		const match = route.pattern.exec(url)
		if (match) return route.handler(req, url, match)
	}
	return null
}

export class SessionManager {
	private sessions = new Map<string, SessionData>()
	private feedback = new Map<string, Map<number, string>>()
	private readonly dir: string

	constructor(sessionsDir?: string) {
		this.dir = sessionsDir ?? join(TEMP_DIR, 'sessions')
		mkdirSync(this.dir, { recursive: true })
	}

	private revDir(id: string, rev: number): string {
		return join(this.dir, id, 'revisions', String(rev))
	}

	upsert(
		id: string,
		canvasFiles: Map<string, string>,
		projectRoot: string,
		label?: string,
		response?: string,
		canvasScope?: CanvasScope,
	): SessionData {
		const existing = this.sessions.get(id)
		const now = new Date().toISOString()
		const revision = existing ? existing.currentRevision + 1 : 1
		const rev: RevisionInfo = {
			revision,
			canvasFiles: [...canvasFiles.keys()].map((filename) => ({ filename })),
			createdAt: now,
			hasFeedback: false,
			feedbackConsumed: false,
			...(label ? { label } : {}),
			...(response ? { response } : {}),
			...(canvasScope ? { canvasScope } : {}),
		}
		const session: SessionData = {
			id,
			projectRoot,
			canvasFiles: [...canvasFiles.keys()],
			currentRevision: revision,
			revisions: existing ? [...existing.revisions, rev] : [rev],
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		}
		const d = this.revDir(id, revision)
		mkdirSync(d, { recursive: true })
		for (const [filename, jsx] of canvasFiles) writeFileSync(join(d, filename), jsx)
		this.sessions.set(id, session)
		return session
	}

	get(id: string): SessionData | undefined {
		return this.sessions.get(id)
	}
	list(): SessionData[] {
		return [...this.sessions.values()]
	}
	remove(id: string): void {
		this.sessions.delete(id)
		rmSync(join(this.dir, id), { recursive: true, force: true })
	}

	saveCompiled(id: string, filename: string, js: string, rev?: number): void {
		const revision = rev ?? this.sessions.get(id)?.currentRevision
		if (!revision) return
		const d = this.revDir(id, revision)
		mkdirSync(d, { recursive: true })
		writeFileSync(join(d, filename.replace(/\.jsx$/, '.compiled.js')), js)
	}
	getCompiled(id: string, filename: string, rev?: number): string | null {
		const revision = rev ?? this.sessions.get(id)?.currentRevision
		if (!revision) return null
		try {
			return readFileSync(join(this.revDir(id, revision), filename.replace(/\.jsx$/, '.compiled.js')), 'utf-8')
		} catch {
			return null
		}
	}

	readRevisionJsx(id: string, rev: number, filename: string): string | null {
		try {
			return readFileSync(join(this.revDir(id, rev), filename), 'utf-8')
		} catch {
			return null
		}
	}
	getRevisionJsxPath(id: string, rev: number, filename: string): string {
		return join(this.revDir(id, rev), filename)
	}
	getRevisionCanvasFiles(id: string, rev: number): string[] {
		const session = this.sessions.get(id)
		return session?.revisions.find((r) => r.revision === rev)?.canvasFiles.map((c) => c.filename) ?? []
	}

	saveFeedback(id: string, rev: number, markdown: string): void {
		if (!this.feedback.has(id)) this.feedback.set(id, new Map())
		this.feedback.get(id)!.set(rev, markdown)
		const ri = this.sessions.get(id)?.revisions.find((r) => r.revision === rev)
		if (ri) {
			ri.hasFeedback = true
			ri.feedbackConsumed = false
		}
	}
	getFeedback(id: string, rev: number): string | null {
		return this.feedback.get(id)?.get(rev) ?? null
	}
	consumeFeedback(id: string, rev: number): void {
		const ri = this.sessions.get(id)?.revisions.find((r) => r.revision === rev)
		if (ri) ri.feedbackConsumed = true
	}
	getLatestUnconsumedFeedback(id: string): { revision: number; feedback: string } | null {
		const session = this.sessions.get(id)
		if (!session) return null
		for (let i = session.revisions.length - 1; i >= 0; i--) {
			const ri = session.revisions[i]!
			if (ri.hasFeedback && !ri.feedbackConsumed) {
				const fb = this.getFeedback(id, ri.revision)
				if (fb) return { revision: ri.revision, feedback: fb }
			}
		}
		return null
	}
}

type FakeWS = {
	data: WSData
	send(payload: string): void
	close(): void
}

export function createWebSocketManager(sm: SessionManager) {
	const browserSockets = new Map<string, Set<FakeWS>>()
	const waitSockets = new Map<string, Set<FakeWS>>()

	function broadcastRevisionUpdate(sessionId: string): void {
		const sockets = browserSockets.get(sessionId)
		if (!sockets) return
		const session = sm.get(sessionId)
		if (!session) return
		const payload = JSON.stringify({ type: 'revision-updated', revisions: session.revisions })
		for (const ws of sockets) ws.send(payload)
	}

	function broadcastWatcherStatus(sessionId: string): void {
		const sockets = browserSockets.get(sessionId)
		if (!sockets) return
		const watching = (waitSockets.get(sessionId)?.size ?? 0) > 0
		const payload = JSON.stringify({ type: 'watcher-status', watching })
		for (const ws of sockets) ws.send(payload)
	}

	const handlers = {
		open(ws: FakeWS) {
			const { type, sessionId } = ws.data
			const map = type === 'browser' ? browserSockets : waitSockets
			if (!map.has(sessionId)) map.set(sessionId, new Set())
			map.get(sessionId)!.add(ws)
			if (type === 'browser') {
				const watching = (waitSockets.get(sessionId)?.size ?? 0) > 0
				ws.send(JSON.stringify({ type: 'watcher-status', watching }))
			} else {
				broadcastWatcherStatus(sessionId)
			}
		},
		message(ws: FakeWS, message: string | Buffer) {
			const { type, sessionId } = ws.data
			if (type !== 'browser') return
			try {
				const data: unknown = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message))
				if (!isRecord(data) || data['type'] !== 'submit' || typeof data['feedback'] !== 'string') return
				const feedback = data['feedback']
				const session = sm.get(sessionId)
				if (!session) return
				sm.saveFeedback(sessionId, session.currentRevision, feedback)
				broadcastRevisionUpdate(sessionId)
				const waiters = waitSockets.get(sessionId)
				if (waiters && waiters.size > 0) {
					sm.consumeFeedback(sessionId, session.currentRevision)
					broadcastRevisionUpdate(sessionId)
					const payload = JSON.stringify({ type: 'submit', feedback })
					for (const waiter of waiters) {
						waiter.send(payload)
						waiter.close()
					}
					waitSockets.delete(sessionId)
				}
			} catch {
			}
		},
		pong() {},
		close(ws: FakeWS) {
			const { type, sessionId } = ws.data
			const map = type === 'browser' ? browserSockets : waitSockets
			map.get(sessionId)?.delete(ws)
			if (map.get(sessionId)?.size === 0) map.delete(sessionId)
			if (type === 'wait') broadcastWatcherStatus(sessionId)
		},
	}

	return {
		handlers,
		broadcastPlanUpdate: (_id: string) => {},
		broadcastRevisionUpdate,
		broadcastWatcherStatus,
		broadcastRemoteFeedback: (_id: string) => {},
	}
}

export function watchSession(_id: string, _sm: SessionManager, _broadcast: (id: string) => void): void {}
export function unwatchSession(_id: string): void {}
export function unwatchAll(): void {}
