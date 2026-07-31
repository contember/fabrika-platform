// The request application. Every route here corresponds to a rule in `fabrika.gates.ts`:
//
//   /healthz        public   no credential, no `can()` — the platform's health check
//   /public/*       public   anonymous; `can()` is always false
//   /api/*          service | human   a machine key OR a logged-in human, then a PER-OBJECT `can()`
//   /*              human    the browser UI
//
// The proxy owns the path gate. Authenticated route middleware verifies its injected token again and
// attaches the caller. Handlers perform the checks a path rule cannot express: whether THIS caller may
// perform THIS action on THAT workspace.

import { defineApp, type Middleware, route } from '@fabrika/app'
import type { Caller } from './authz'
import { ANONYMOUS } from './authz'
import type { Note, NotesStore } from './notes'

export interface HandlerDeps {
	/** Verifies the proxy-injected token. Returns null when there is none, or it does not verify. */
	readCaller: (request: Request) => Promise<Caller | null>
	notes: NotesStore
	/** Injected so the handler stays deterministic under test. */
	newId?: () => string
	/** Receives an unhandled request error before the opaque response is returned. */
	onError?: (error: unknown) => void
	/** Optional only so request-kernel tests do not need to build the browser SDK. */
	operationsBrowser?: OperationsBrowserFixture
}

export interface OperationsBrowserFixture {
	dsn: string
	release: string
	script: string
}

interface AppContext {
	deps: HandlerDeps
	request: Request
	url: URL
	caller?: Caller
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

const authenticate: Middleware<AppContext> = async (request, ctx, next) => {
	const caller = await ctx.deps.readCaller(request)
	if (caller === null) {
		return json({ error: 'unauthenticated' }, 401)
	}
	ctx.caller = caller
	return next()
}

const authenticatedCaller = (ctx: AppContext): Caller => {
	if (ctx.caller === undefined) {
		throw new Error('authenticated route middleware did not provide a caller')
	}
	return ctx.caller
}

export const notesApp = defineApp<HandlerDeps, AppContext>({
	context: (deps, request) => ({ deps, request, url: new URL(request.url) }),
	routes: [
		route.get('/healthz', () => json({ status: 'ok' })),
		route.get('/public/*path', () => json({ app: 'notes', caller: ANONYMOUS.subject })),
		route.get('/operations-sdk', (ctx) => operationsSdkPage(ctx.deps), { use: [authenticate] }),
		route.get('/operations-sdk/config', (ctx) => operationsSdkConfig(ctx.deps), { use: [authenticate] }),
		route.get('/operations-sdk.js', (ctx) => operationsSdkScript(ctx.deps), { use: [authenticate] }),
		route.get('/api/notes', (ctx) => list(ctx.deps, authenticatedCaller(ctx), ctx.url), { use: [authenticate] }),
		route.post('/api/notes', (ctx) => create(ctx.deps, authenticatedCaller(ctx), ctx.request), { use: [authenticate] }),
		route.delete('/api/notes/:id', (ctx, params) => remove(ctx.deps, authenticatedCaller(ctx), ctx.url, params.id), { use: [authenticate] }),
		route.get(
			'/',
			(ctx) => {
				const caller = authenticatedCaller(ctx)
				// `null` means the action is unrestricted. A naive `includes()` would get this wrong.
				return json({ caller: caller.subject, label: caller.label, workspaces: caller.scopedTo('notes.read', 'workspace') })
			},
			{ use: [authenticate] },
		),
	],
	onError: (error, _request, deps) => {
		deps.onError?.(error)
		return json({ error: 'internal error' }, 500)
	},
})

const operationsFixture = (deps: HandlerDeps): OperationsBrowserFixture | null => deps.operationsBrowser ?? null

const operationsSdkPage = (deps: HandlerDeps): Response => {
	if (operationsFixture(deps) === null) return json({ error: 'not found' }, 404)
	return new Response(
		'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Operations SDK witness</title></head>'
			+ '<body><main><h1>Operations SDK witness</h1><label>Error marker <input id="error-marker" readonly></label>'
			+ '<button type="button" id="capture-error">Capture managed error</button>'
			+ '<p id="capture-status" role="status">Ready</p></main><script type="module" src="/operations-sdk.js"></script></body></html>',
		{ headers: { 'content-type': 'text/html; charset=utf-8' } },
	)
}

const operationsSdkConfig = (deps: HandlerDeps): Response => {
	const fixture = operationsFixture(deps)
	return fixture === null ? json({ error: 'not found' }, 404) : json({ dsn: fixture.dsn, release: fixture.release })
}

const operationsSdkScript = (deps: HandlerDeps): Response => {
	const fixture = operationsFixture(deps)
	return fixture === null
		? json({ error: 'not found' }, 404)
		: new Response(fixture.script, { headers: { 'content-type': 'text/javascript; charset=utf-8' } })
}

/** The scope every `/api/*` route is evaluated against. Absent is a 400, never a silent "all workspaces". */
const workspaceOf = (url: URL): string | null => {
	const value = url.searchParams.get('workspace')
	return value === null || value === '' ? null : value
}

const list = async (deps: HandlerDeps, caller: Caller, url: URL): Promise<Response> => {
	const workspace = workspaceOf(url)
	if (workspace === null) {
		return json({ error: 'workspace is required' }, 400)
	}
	if (!caller.can('notes.read', { type: 'workspace', value: workspace })) {
		return json({ error: 'forbidden' }, 403)
	}
	return json({ notes: await deps.notes.list(workspace) })
}

const create = async (deps: HandlerDeps, caller: Caller, request: Request): Promise<Response> => {
	const url = new URL(request.url)
	const workspace = workspaceOf(url)
	if (workspace === null) {
		return json({ error: 'workspace is required' }, 400)
	}
	if (!caller.can('notes.write', { type: 'workspace', value: workspace })) {
		return json({ error: 'forbidden' }, 403)
	}
	const body: unknown = await request.json().catch(() => null)
	const title = typeof body === 'object' && body !== null && 'title' in body && typeof body.title === 'string' ? body.title : null
	if (title === null || title === '') {
		return json({ error: 'title is required' }, 400)
	}
	const note: Note = { id: deps.newId?.() ?? crypto.randomUUID(), workspace, title }
	await deps.notes.create(note)
	return json({ note }, 201)
}

const remove = async (deps: HandlerDeps, caller: Caller, url: URL, id: string): Promise<Response> => {
	const workspace = workspaceOf(url)
	if (workspace === null) {
		return json({ error: 'workspace is required' }, 400)
	}
	// A separate action from `notes.write`: an author may write without being allowed to delete.
	if (!caller.can('notes.delete', { type: 'workspace', value: workspace })) {
		return json({ error: 'forbidden' }, 403)
	}
	return (await deps.notes.remove(workspace, id)) ? json({ deleted: id }) : json({ error: 'not found' }, 404)
}
