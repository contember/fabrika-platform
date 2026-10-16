import { type AssertReadable, type CanvasScope, compileJsx, type SessionManager, watchSession } from '@fabrika/canvas-kernel/server'
import { jsonResponse, type Route } from '@fabrika/daemon-kit'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, join } from 'path'
import type { z } from 'zod'
import { builderDaemonUrl, buildEventSchema, planInputSchema } from '../../shared'
import type { BuildEvent, BuildStream } from './build-stream'
import { COMPILE_TEMP_DIR } from './paths'
import { derivePhaseState, type GateOracle } from './phases'
import { BuilderPlatform } from './platform'
import { PlatformError } from './platform-storage'

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function routeParam(match: URLPatternResult, name: string): string {
	const value = match.pathname.groups[name]
	if (value === undefined) throw new Error(`Missing route parameter: ${name}`)
	return value
}

export interface HandlerContext {
	sessionManager: SessionManager
	broadcastPlanUpdate: (id: string) => void
	broadcastRevisionUpdate: (id: string) => void
	buildStream: BuildStream
	sessionsDir: string
	port: number
	version: string
	platform?: BuilderPlatform
}

function gateOracleFor(sm: SessionManager): GateOracle {
	return {
		getLatestUnconsumedFeedback: (id) => sm.getLatestUnconsumedFeedback(id),
		hasGateRevision: (id, gateName) => {
			const session = sm.get(id)
			if (!session) return false
			for (let i = session.revisions.length - 1; i >= 0; i--) {
				const r = session.revisions[i]!
				if (r.label === gateName) return r.hasFeedback
			}
			return false
		},
	}
}

interface CanvasSelection {
	files: Map<string, string>
	scope: CanvasScope
}

function readCanvasFile(path: string, assertReadable: AssertReadable): string {
	try {
		assertReadable(path)
		return readFileSync(path, 'utf-8')
	} catch {
		throw new Error('Canvas file access refused')
	}
}

function resolveCanvasSelection(body: z.infer<typeof planInputSchema>, assertReadable: AssertReadable): CanvasSelection {
	const view = body.view ?? null
	const directory = body.directory ?? null
	if (!!view === !!directory) {
		throw new Error('Provide exactly one of view or directory')
	}

	if (view) {
		if (!existsSync(view) || !statSync(view).isFile()) {
			throw new Error(`Canvas view not found: ${view}`)
		}
		if (extname(view).toLowerCase() !== '.jsx') {
			throw new Error(`Canvas view must be a .jsx file: ${view}`)
		}
		const filename = basename(view)
		return {
			files: new Map([[filename, readCanvasFile(view, assertReadable)]]),
			scope: { kind: 'view', filename },
		}
	}

	if (directory === null) throw new Error('Canvas directory is missing')
	if (!existsSync(directory) || !statSync(directory).isDirectory()) {
		throw new Error(`Canvas directory not found: ${directory}`)
	}
	const filenames = readdirSync(directory).filter((f) => f.endsWith('.jsx')).sort()
	if (filenames.length === 0) throw new Error('No .jsx files found in directory')
	const files = new Map<string, string>()
	for (const filename of filenames) {
		files.set(filename, readCanvasFile(join(directory, filename), assertReadable))
	}
	return { files, scope: { kind: 'directory' } }
}

export function createHandlers(ctx: HandlerContext): Route[] {
	const { sessionManager, broadcastPlanUpdate, broadcastRevisionUpdate, buildStream } = ctx
	const platform = ctx.platform ?? new BuilderPlatform((id) => sessionManager.get(id)?.projectRoot)
	const assertReadable: AssertReadable = (path) => platform.storage.assertPublicFile(path)

	function handleHealth(): Response {
		return jsonResponse({
			ok: true,
			version: ctx.version,
			pid: process.pid,
			dataDir: dirname(ctx.sessionsDir),
			sessionsDir: ctx.sessionsDir,
			sessions: sessionManager.list().map((s) => s.id),
		})
	}

	function handlePhase(_req: Request, url: URL): Response {
		const sessionId = url.searchParams.get('session') ?? ''
		try {
			const projectRoot = sessionId ? platform.projectRoot(sessionId) : undefined
			const root = url.searchParams.get('root') ?? (projectRoot ? join(projectRoot, '.fabrika') : null)
			if (!root) return jsonResponse({ error: 'Missing ?root=<fabrikaDir>' }, 400)
			const state = derivePhaseState(root, sessionId, gateOracleFor(sessionManager))
			return jsonResponse(state)
		} catch (error: unknown) {
			return jsonResponse({ error: errorMessage(error) }, 500)
		}
	}

	async function handlePlanPost(req: Request, _url: URL, match: URLPatternResult): Promise<Response> {
		const sessionId = routeParam(match, 'id')
		try {
			const parsedBody = planInputSchema.safeParse(await req.json())
			if (!parsedBody.success) return jsonResponse({ error: 'Expected a JSON object' }, 400)
			const body = parsedBody.data
			let selection: CanvasSelection
			try {
				selection = resolveCanvasSelection(body, assertReadable)
			} catch (error) {
				return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400)
			}
			const canvasFiles = selection.files

			const unconsumed = sessionManager.getLatestUnconsumedFeedback(sessionId)
			if (unconsumed) {
				sessionManager.consumeFeedback(sessionId, unconsumed.revision)
				return jsonResponse(
					{
						ok: false,
						error: `Unconsumed feedback from revision ${unconsumed.revision}. Address the feedback before pushing a new canvas.`,
						unconsumedFeedback: unconsumed.feedback,
						unconsumedRevision: unconsumed.revision,
					},
					409,
				)
			}

			const boundRoot = platform.projectRoot(sessionId)
			const projectRoot = platform.storage.assertProjectRoot(boundRoot ?? body.projectRoot ?? process.cwd(), true)
			const isNew = !sessionManager.get(sessionId)
			const gate = body.gate
			const label = gate ?? body.label
			const response = body.response

			const compiled = new Map<string, string>()
			const errors: Record<string, string> = {}
			await Promise.all(
				[...canvasFiles.entries()].map(async ([filename, jsx]) => {
					const result = await compileJsx(jsx, { projectRoot, tempDir: COMPILE_TEMP_DIR, assertReadable })
					if (result.ok) compiled.set(filename, result.js)
					else errors[filename] = result.error
				}),
			)
			if (Object.keys(errors).length > 0) {
				return jsonResponse({ ok: false, error: 'Canvas compilation failed', errors }, 400)
			}

			const session = sessionManager.upsert(
				sessionId,
				canvasFiles,
				projectRoot,
				label,
				response,
				selection.scope,
			)
			for (const [filename, js] of compiled) {
				sessionManager.saveCompiled(sessionId, filename, js, session.currentRevision)
			}

			broadcastPlanUpdate(sessionId)
			watchSession(sessionId, sessionManager, broadcastPlanUpdate, { tempDir: COMPILE_TEMP_DIR, assertReadable })

			const browserUrl = `${builderDaemonUrl(ctx.port)}/s/${sessionId}`
			return jsonResponse({
				ok: true,
				browserUrl,
				isNew,
				revision: session.currentRevision,
				sessionId,
				...(gate === undefined ? {} : { gate }),
				canvasFiles: [...canvasFiles.keys()],
			})
		} catch (error: unknown) {
			return jsonResponse({ error: errorMessage(error) }, 500)
		}
	}

	async function handleCanvasJs(_req: Request, url: URL, match: URLPatternResult): Promise<Response> {
		const sessionId = routeParam(match, 'id')
		const jsFilename = routeParam(match, 'filename')
		const jsxFilename = jsFilename.replace(/\.js$/, '.jsx')
		const revParam = url.searchParams.get('rev')
		const rev = revParam ? parseInt(revParam, 10) : undefined

		const session = sessionManager.get(sessionId)
		const revision = rev ?? session?.currentRevision
		if (!session || !revision || !session.revisions.some((r) => r.revision === revision && r.canvasFiles.some((f) => f.filename === jsxFilename))) {
			return jsonResponse({ error: 'No compiled canvas' }, 404)
		}
		try {
			const projectRoot = platform.storage.assertProjectRoot(session.projectRoot)
			const jsx = readCanvasFile(sessionManager.getRevisionJsxPath(sessionId, revision, jsxFilename), assertReadable)
			// Stored bundles predate admission and dependencies can change after a successful compile.
			const result = await compileJsx(jsx, { projectRoot, tempDir: COMPILE_TEMP_DIR, assertReadable })
			if (!result.ok) return jsonResponse({ error: 'Canvas compilation failed' }, 400)
			sessionManager.saveCompiled(sessionId, jsxFilename, result.js, revision)
			return new Response(result.js, {
				headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' },
			})
		} catch {
			return jsonResponse({ error: 'Canvas file access refused' }, 403)
		}
	}

	function handleMeta(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const session = sessionManager.get(sessionId)
		if (!session) {
			const project = platform.storage.project(sessionId)
			if (!project) return jsonResponse({ error: 'Session not found' }, 404)
			const config = platform.storage.config(project)
			return jsonResponse({
				projectRoot: project.projectRoot,
				currentRevision: 0,
				revisions: [],
				canvasFiles: [],
				createdAt: config.createdAt,
				updatedAt: config.createdAt,
			})
		}
		return jsonResponse({
			projectRoot: session.projectRoot,
			currentRevision: session.currentRevision,
			revisions: session.revisions,
			canvasFiles: session.canvasFiles,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
		})
	}

	function handleArtifact(_req: Request, url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const projectRoot = platform.projectRoot(sessionId)
		if (!projectRoot) return jsonResponse({ error: 'Session not found' }, 404)

		const rel = url.searchParams.get('path')
		if (!rel) return jsonResponse({ error: 'Missing ?path=<relative path>' }, 400)

		try {
			const target = platform.storage.artifact(projectRoot, rel)
			platform.storage.assertPublicFile(target)
			const st = statSync(target)
			if (!st.isFile()) return jsonResponse({ error: 'Not a file' }, 404)
			return jsonResponse({ path: rel, content: readFileSync(target, 'utf-8') })
		} catch (error) {
			return jsonResponse({ error: 'Artifact not found or outside the project' }, error instanceof PlatformError ? 403 : 404)
		}
	}

	function handleSkeletons(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const session = sessionManager.get(sessionId)
		if (!session) return jsonResponse({ error: 'Session not found' }, 404)
		const dir = join(session.projectRoot, 'tests', 'browser')
		if (!existsSync(dir)) return jsonResponse({ skeletons: [] })

		const matchBrace = (s: string, open: number): number => {
			let depth = 0
			for (let i = open; i < s.length; i++) {
				if (s[i] === '{') depth++
				else if (s[i] === '}' && --depth === 0) return i
			}
			return -1
		}
		const routePath = (u: string | undefined): string | undefined => {
			if (!u) return undefined
			let s = u.replace(/\$\{[^}]*\}/g, '').replace(/^https?:\/\/[^/]+/, '')
			s = s.split('#')[0]!.split('?')[0]!
			if (!s.startsWith('/')) s = '/' + s
			return s.replace(/\/{2,}/g, '/') || '/'
		}

		const skeletons: unknown[] = []
		for (const entry of readdirSync(dir).sort()) {
			if (!/\.test\.ts$/.test(entry)) continue
			try {
				platform.storage.artifact(session.projectRoot, join('tests', 'browser', entry))
				platform.storage.assertPublicFile(join(dir, entry))
			} catch {
				continue
			}
			const src = readFileSync(join(dir, entry), 'utf-8')
			const re = /browserTest\s*\(/g
			let mm: RegExpExecArray | null
			while ((mm = re.exec(src))) {
				const objStart = src.indexOf('{', mm.index)
				if (objStart === -1) continue
				const objEnd = matchBrace(src, objStart)
				if (objEnd === -1) continue
				const meta = src.slice(objStart, objEnd + 1)
				const str = (k: string) => meta.match(new RegExp(`\\b${k}\\s*:\\s*[\`'"]([^\`'"]*)`))?.[1]
				const arr = (k: string) => {
					const a = meta.match(new RegExp(`\\b${k}\\s*:\\s*\\[([\\s\\S]*?)\\]`))?.[1] ?? ''
					return [...a.matchAll(/[`'"]([^`'"]+)[`'"]/g)].map((x) => x[1])
				}
				const after = src.slice(objEnd + 1)
				const nextBT = after.search(/\bbrowserTest\s*\(/)
				const body = nextBT === -1 ? after : after.slice(0, nextBT)
				const steps = (body.match(/\bstep(?:\.\w+)?\s*\(/g) ?? []).length
				const invariants = (body.match(/\binvariant(?:\.\w+)?\s*\(/g) ?? []).length
				const pending = (body.match(/\bstep\s*\(\s*[`'"][^`'"]*[`'"]\s*,\s*\{[^}]*\}\s*\)/g) ?? []).length
					+ (body.match(/\binvariant\.todo\s*\(/g) ?? []).length
				skeletons.push({
					file: entry,
					name: str('name') ?? entry.replace(/\.test\.ts$/, ''),
					url: routePath(str('url')),
					feature: str('feature'),
					seeds: arr('seeds'),
					roles: arr('roles'),
					steps,
					invariants,
					pending,
				})
			}
		}
		return jsonResponse({ skeletons })
	}

	function handleFeedbackGet(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const rev = parseInt(routeParam(match, 'rev'), 10)
		const feedback = sessionManager.getFeedback(sessionId, rev)
		if (feedback === null) return jsonResponse({ error: 'No feedback' }, 404)
		return jsonResponse({ feedback })
	}

	function handleFeedbackConsume(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const result = sessionManager.getLatestUnconsumedFeedback(sessionId)
		if (!result) return jsonResponse({ found: false })
		sessionManager.consumeFeedback(sessionId, result.revision)
		broadcastRevisionUpdate(sessionId)
		return jsonResponse({ found: true, revision: result.revision, feedback: result.feedback })
	}

	function handleResponsesGet(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const rev = parseInt(routeParam(match, 'rev'), 10)
		const responses = sessionManager.getResponses(sessionId, rev)
		return jsonResponse({ responses })
	}

	async function handleResponsesPut(req: Request, _url: URL, match: URLPatternResult): Promise<Response> {
		const sessionId = routeParam(match, 'id')
		const rev = parseInt(routeParam(match, 'rev'), 10)
		if (!sessionManager.get(sessionId)) return jsonResponse({ error: 'Session not found' }, 404)
		try {
			const body = await req.json()
			sessionManager.saveResponses(sessionId, rev, body)
			return jsonResponse({ ok: true })
		} catch (error: unknown) {
			return jsonResponse({ error: errorMessage(error) }, 400)
		}
	}

	function handleSessionReset(_req: Request, _url: URL, match: URLPatternResult): Response {
		const sessionId = routeParam(match, 'id')
		const existed = !!sessionManager.get(sessionId)
		if (existed) {
			sessionManager.remove(sessionId)
			broadcastRevisionUpdate(sessionId)
		}
		return jsonResponse({ ok: true, existed })
	}

	function handleSessions(): Response {
		return jsonResponse(
			sessionManager.list().map((s) => ({
				id: s.id,
				projectRoot: s.projectRoot,
				currentRevision: s.currentRevision,
				updatedAt: s.updatedAt,
			})),
		)
	}

	async function handleBuildEvent(req: Request): Promise<Response> {
		try {
			const body: unknown = await req.json()
			const event = buildEventSchema.safeParse(body)
			if (!event.success) return jsonResponse({ error: 'Invalid or missing status' }, 400)
			const ev = buildStream.append(event.data)
			return jsonResponse({ ok: true, event: ev })
		} catch (error: unknown) {
			return jsonResponse({ error: errorMessage(error) }, 500)
		}
	}

	function handleBuildStream(): Response {
		const encoder = new TextEncoder()
		let unsubscribe: (() => void) | null = null
		const stream = new ReadableStream({
			start(controller) {
				const send = (ev: BuildEvent) => {
					try {
						controller.enqueue(encoder.encode(`data: ${JSON.stringify(ev)}\n\n`))
					} catch {
					}
				}
				for (const ev of buildStream.history()) send(ev)
				controller.enqueue(encoder.encode(`: connected\n\n`))
				unsubscribe = buildStream.subscribe(send)
			},
			cancel() {
				unsubscribe?.()
			},
		})
		return new Response(stream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache, no-transform',
				Connection: 'keep-alive',
			},
		})
	}

	return [
		{ method: 'GET', pattern: new URLPattern({ pathname: '/health' }), handler: handleHealth },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/phase' }), handler: handlePhase },
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/plan' }), handler: handlePlanPost },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/canvas/:filename' }), handler: handleCanvasJs },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/meta' }), handler: handleMeta },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/artifact' }), handler: handleArtifact },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/skeletons' }), handler: handleSkeletons },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/revision/:rev/feedback' }), handler: handleFeedbackGet },
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/feedback/consume' }), handler: handleFeedbackConsume },
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/session/:id/reset' }), handler: handleSessionReset },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/session/:id/revision/:rev/responses' }), handler: handleResponsesGet },
		{ method: 'PUT', pattern: new URLPattern({ pathname: '/api/session/:id/revision/:rev/responses' }), handler: handleResponsesPut },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/sessions' }), handler: handleSessions },
		{ method: 'POST', pattern: new URLPattern({ pathname: '/api/build/event' }), handler: handleBuildEvent },
		{ method: 'GET', pattern: new URLPattern({ pathname: '/api/build/stream' }), handler: handleBuildStream },
	]
}
