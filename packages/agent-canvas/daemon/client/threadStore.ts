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

/**
 * The newer copy of each thread, in the current order. Responses and socket frames can arrive out of order (a POST's
 * response after the frame for the agent's claim), and threads are never deleted, so none is dropped.
 */
export function mergeThreads(current: readonly CanvasThread[], incoming: readonly CanvasThread[]): readonly CanvasThread[] {
	const arrived = new Map(incoming.map((thread) => [thread.id, thread]))
	const merged = current.map((mine) => {
		const theirs = arrived.get(mine.id)
		return theirs !== undefined && theirs.updatedAt >= mine.updatedAt ? theirs : mine
	})
	const known = new Set(current.map((thread) => thread.id))
	return [...merged, ...incoming.filter((thread) => !known.has(thread.id))]
}

/** The local daemon's threads for one session, kept current by its socket. */
export function createThreadStore(sessionId: string): LocalThreadStore {
	let threads: readonly CanvasThread[] = []
	const listeners = new Set<() => void>()
	const base = `/api/session/${encodeURIComponent(sessionId)}/threads`

	const merge = (incoming: readonly CanvasThread[]) => {
		threads = mergeThreads(threads, incoming)
		for (const listener of listeners) listener()
	}

	const post = async (path: string, body: unknown) => {
		const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
		if (!response.ok) throw await requestError(response)
		merge([threadResponseSchema.parse(await response.json()).thread])
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
			merge(threadsResponseSchema.parse(await response.json()).threads)
		},
		receive(payload) {
			const parsed = z.array(canvasThreadSchema).safeParse(payload)
			if (parsed.success) merge(parsed.data)
		},
		reply: (threadId, body) => post(`${encodeURIComponent(threadId)}/comments`, { body }),
		setResolved: (threadId, resolved) => post(`${encodeURIComponent(threadId)}/resolved`, { resolved }),
	}
}
