// The request handler. Every route here corresponds to a rule in `fabrika.gates.ts`, and the mapping is
// the point of this file:
//
//   /healthz        public   no credential, no `can()` — the platform's health check
//   /public/*       public   anonymous; `can()` is always false, which is why the route asks nothing of it
//   /api/*          service | human   a machine key OR a logged-in human, then a PER-OBJECT `can()`
//   /*              human    the browser UI
//
// The app does NOT re-check the gate. It could not do so correctly anyway — falling through from
// `service` to `human` requires exchanging a session with IAM, which is the proxy's job. What the app
// checks is the thing a per-path rule cannot express: whether THIS caller may perform THIS action on
// THAT workspace.
//
// A missing or unverifiable token on a gated route is answered 401 rather than trusted. In production
// that response should be unreachable — the proxy would not have forwarded the request — so seeing one
// means either the proxy was bypassed or the token header was stripped, and both are worth a 401.

import type { Caller } from './authz'
import { ANONYMOUS } from './authz'
import type { Note, NotesStore } from './notes'

export interface HandlerDeps {
	/** Verifies the proxy-injected token. Returns null when there is none, or it does not verify. */
	readCaller: (request: Request) => Promise<Caller | null>
	notes: NotesStore
	/** Injected so the handler stays deterministic under test. */
	newId?: () => string
}

const json = (body: unknown, status = 200): Response => Response.json(body, { status })

/** Paths the gates declare `public`. Listed once so the handler and the gate list can be compared. */
const PUBLIC_PATHS = (pathname: string): boolean => pathname === '/healthz' || pathname.startsWith('/public/')

export const createHandler = (deps: HandlerDeps): (request: Request) => Promise<Response> => {
	const newId = deps.newId ?? (() => crypto.randomUUID())

	return async (request: Request): Promise<Response> => {
		const url = new URL(request.url)
		const path = url.pathname

		if (PUBLIC_PATHS(path)) {
			// Anonymous by construction: `ANONYMOUS.can()` is always false, so a public route that grew an
			// authorization check later would fail closed rather than accidentally pass.
			return path === '/healthz' ? json({ status: 'ok' }) : json({ app: 'notes', caller: ANONYMOUS.subject })
		}

		const caller = await deps.readCaller(request)
		if (caller === null) {
			return json({ error: 'unauthenticated' }, 401)
		}

		if (path === '/api/notes') {
			return request.method === 'POST' ? create(deps, caller, request, newId) : list(deps, caller, url)
		}
		const deleteMatch = /^\/api\/notes\/([^/]+)$/.exec(path)
		if (deleteMatch !== null && request.method === 'DELETE') {
			return remove(deps, caller, url, deleteMatch[1] ?? '')
		}
		if (path === '/') {
			// The browser UI. `scopedTo` returns the workspaces this caller may read — `null` means "all of
			// them", which is what a `*` grant produces and what a naive `includes()` would get wrong.
			return json({ caller: caller.subject, label: caller.label, workspaces: caller.scopedTo('notes.read', 'workspace') })
		}
		return json({ error: 'not found' }, 404)
	}
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

const create = async (deps: HandlerDeps, caller: Caller, request: Request, newId: () => string): Promise<Response> => {
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
	const note: Note = { id: newId(), workspace, title }
	await deps.notes.create(note)
	return json({ note }, 201)
}

const remove = async (deps: HandlerDeps, caller: Caller, url: URL, id: string): Promise<Response> => {
	const workspace = workspaceOf(url)
	if (workspace === null) {
		return json({ error: 'workspace is required' }, 400)
	}
	// A separate action from `notes.write` on purpose: the `author` role in `fabrika.schema.ts` can write
	// but not delete, and that distinction only exists if the code actually asks for the narrower one.
	if (!caller.can('notes.delete', { type: 'workspace', value: workspace })) {
		return json({ error: 'forbidden' }, 403)
	}
	return (await deps.notes.remove(workspace, id)) ? json({ deleted: id }) : json({ error: 'not found' }, 404)
}
