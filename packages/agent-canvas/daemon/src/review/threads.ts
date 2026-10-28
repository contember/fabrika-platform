import type { ReviewComment, ReviewThreadState } from './model'

/**
 * The thread lifecycle, shared by the daemon's file store and the share worker's encrypted store. It reads and writes
 * only state, comments and timestamps; the anchor and the screenshot are each store's own, so a comment body here may be
 * plaintext or ciphertext.
 */

export class ReviewError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message)
	}
}

export interface ThreadCore {
	id: string
	state: ReviewThreadState
	comments: ReviewComment[]
	updatedAt: string
}

/** A note the person saved and has not sent: open, with their own comment last rather than the agent's answer. */
export function isUnsentNote(thread: ThreadCore): boolean {
	return thread.state === 'open' && thread.comments.at(-1)?.author === 'user'
}

export function openingState(send: boolean): ReviewThreadState {
	return send ? 'queued' : 'open'
}

/** A comment from the person reopens a resolved thread; with `send` it goes to the agent. */
export function userCommented<T extends ThreadCore>(thread: T, comment: ReviewComment, send: boolean): T {
	const state: ReviewThreadState = send ? 'queued' : thread.state === 'resolved' ? 'open' : thread.state
	return { ...thread, comments: [...thread.comments, comment], state, updatedAt: comment.createdAt }
}

export function sent<T extends ThreadCore>(thread: T, now: string): T {
	if (thread.state === 'working') throw new ReviewError('The agent is already working on this thread', 409)
	return { ...thread, state: 'queued', updatedAt: now }
}

/** Sends every unsent note at once, so the agent picks them up as one batch. */
export function notesSent<T extends ThreadCore>(threads: readonly T[], now: string): { threads: T[]; sent: T[] } {
	const sentNotes = threads.filter(isUnsentNote).map((thread): T => ({ ...thread, state: 'queued', updatedAt: now }))
	const sentById = new Map(sentNotes.map((thread) => [thread.id, thread]))
	return { threads: threads.map((thread) => sentById.get(thread.id) ?? thread), sent: sentNotes }
}

export function resolvedAs<T extends ThreadCore>(thread: T, resolved: boolean, now: string): T {
	return { ...thread, state: resolved ? 'resolved' : 'open', updatedAt: now }
}

/** Hands every queued thread to the agent: they become `working` and are returned in their original order. */
export function claimed<T extends ThreadCore>(threads: readonly T[], now: string): { threads: T[]; claimed: T[] } {
	const taken = threads.filter((thread) => thread.state === 'queued').map((thread): T => ({ ...thread, state: 'working', updatedAt: now }))
	const takenById = new Map(taken.map((thread) => [thread.id, thread]))
	return { threads: threads.map((thread) => takenById.get(thread.id) ?? thread), claimed: taken }
}

/** The agent's answer. Without `resolve` the thread goes back to the person as `open`. */
export function agentReplied<T extends ThreadCore>(thread: T, comment: ReviewComment, resolve: boolean): T {
	return { ...thread, comments: [...thread.comments, comment], state: resolve ? 'resolved' : 'open', updatedAt: comment.createdAt }
}
