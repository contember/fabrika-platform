import type { CanvasThreads } from '@fabrika/canvas-kernel/client'
import { z } from 'zod'
import { type CanvasThread, canvasThreadSchema } from '../src/threads'

const threadsResponseSchema = z.object({ threads: z.array(canvasThreadSchema) })
const threadResponseSchema = z.object({ thread: canvasThreadSchema })

export interface LocalThreadStore extends CanvasThreads {
	/** Reads the session's threads, e.g. after the socket (re)connects. */
	load: () => Promise<void>
	/** A `threads` frame's payload from the session socket. */
	receive: (threads: unknown) => void
}

async function requestError(response: Response): Promise<Error> {
	const raw: unknown = await response.json().catch(() => null)
	const parsed = z.object({ error: z.string() }).safeParse(raw)
	return new Error(parsed.success ? parsed.data.error : `Thread request failed with status ${response.status}`)
}

/** The local daemon's threads for one session, kept current by its socket. */
export function createThreadStore(sessionId: string): LocalThreadStore {
	let threads: readonly CanvasThread[] = []
	const listeners = new Set<() => void>()
	const base = `/api/session/${encodeURIComponent(sessionId)}/threads`

	const set = (next: readonly CanvasThread[]) => {
		threads = next
		for (const listener of listeners) listener()
	}

	const post = async (path: string, body: unknown) => {
		const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		if (!response.ok) throw await requestError(response)
		const { thread } = threadResponseSchema.parse(await response.json())
		// The socket brings the same update, and may already have brought a newer one (the agent claimed the reply).
		set(threads.map((candidate) => (candidate.id === thread.id && thread.updatedAt > candidate.updatedAt ? thread : candidate)))
	}

	return {
		subscribe(onChange) {
			listeners.add(onChange)
			return () => listeners.delete(onChange)
		},
		current: () => threads,
		async load() {
			const response = await fetch(base, { cache: 'no-store' })
			if (!response.ok) throw await requestError(response)
			set(threadsResponseSchema.parse(await response.json()).threads)
		},
		receive(payload) {
			const parsed = z.array(canvasThreadSchema).safeParse(payload)
			if (parsed.success) set(parsed.data)
		},
		reply: (threadId, body) => post(`${encodeURIComponent(threadId)}/comments`, { body }),
		setResolved: (threadId, resolved) => post(`${encodeURIComponent(threadId)}/resolved`, { resolved }),
	}
}
