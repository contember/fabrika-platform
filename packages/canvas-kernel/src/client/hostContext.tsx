import { type ComponentType, createContext, useContext } from 'react'

/**
 * What the annotation surface needs from the host serving it.
 *
 * The kernel ships a local-daemon implementation, so a host that serves
 * canvases straight off its own daemon needs no provider. Hosts with extra
 * delivery modes (agent-canvas also serves read-only encrypted share links)
 * provide their own.
 */
export interface CanvasHost {
	/** Session the canvas belongs to. */
	sessionId: string
	/** Read-only share view — local-only affordances stay hidden. */
	isShared: boolean
	/** Host can read project files (feedback bodies, file browser). */
	fsAvailable: boolean
	/** Endpoint accepting annotation image uploads, or `null` for a host that
	 *  has none — the attach affordances then stay hidden rather than posting
	 *  into the void. Required, not optional, so no host can be silent about it. */
	uploadUrl: (() => string) | null
	/** Fetch and `import()` a compiled canvas module. */
	loadCanvasModule: (filename: string, revision?: number) => Promise<CanvasModule>
	/** Threads the agent opened by answering submitted annotations, or `null` for a host whose agent cannot answer
	 *  one: the submit then carries no annotation ids and the sidebar shows no threads. */
	threads: CanvasThreads | null
}

/** `open` waits on the user, `queued` holds a reply the agent has not read, `working` is with the agent, `resolved` is closed. */
export type CanvasThreadState = 'open' | 'queued' | 'working' | 'resolved'

export interface CanvasThreadComment {
	id: string
	author: 'user' | 'agent'
	body: string
	createdAt: string
}

/** A conversation on one submitted annotation. It outlives the revision it was submitted on. */
export interface CanvasThread {
	/** The annotation's id. */
	id: string
	state: CanvasThreadState
	/** The revision the annotation was submitted on. */
	revision: number
	snippet: string
	canvasFile?: string
	filePath?: string
	comments: readonly CanvasThreadComment[]
}

/** A store the sidebar subscribes to; the host keeps it current. */
export interface CanvasThreads {
	subscribe: (onChange: () => void) => () => void
	current: () => readonly CanvasThread[]
	reply: (threadId: string, body: string) => Promise<void>
	setResolved: (threadId: string, resolved: boolean) => Promise<void>
}

/** What the canvas compiler emits: one module whose default export renders the canvas. */
export interface CanvasModule {
	default: ComponentType
}

/** Local mode carries the session id as the `/s/:id` path suffix. */
function localSessionId(): string {
	if (typeof window === 'undefined') return ''
	return window.location.pathname.replace('/s/', '')
}

export const localCanvasHost: CanvasHost = {
	get sessionId() {
		return localSessionId()
	},
	isShared: false,
	fsAvailable: true,
	// No endpoint by default. The only hosts that reach this fallback are the
	// ones that configured nothing, which are exactly the ones least likely to
	// serve an upload route — claiming one on their behalf is how every host got
	// a paperclip that posts into the void. A host with uploads names its own.
	uploadUrl: null,
	loadCanvasModule: (filename, revision) => {
		const jsName = filename.replace(/\.jsx$/, '.js')
		const query = revision ? `?rev=${revision}&t=${Date.now()}` : `?t=${Date.now()}`
		const url = `/api/session/${localSessionId()}/canvas/${encodeURIComponent(jsName)}${query}`
		return import(/* @vite-ignore */ url)
	},
	threads: null,
}

export const CanvasHostContext = createContext<CanvasHost>(localCanvasHost)

export function useCanvasHost(): CanvasHost {
	return useContext(CanvasHostContext)
}
