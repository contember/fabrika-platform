import type { SessionManager } from '@fabrika/canvas-kernel/server'
import { z } from 'zod'
import { reviewCommentSchema, reviewThreadStateSchema } from './review/model'
import type { ReviewAuthor, ReviewComment } from './review/model'
import { agentReplied, claimed, resolvedAs, ReviewError, userCommented } from './review/threads'

/**
 * Threads on a canvas session's submitted annotations. The agent opens one by answering an annotation; the user
 * answers back from the sidebar. The lifecycle is review mode's (`review/threads.ts`); a thread's id is the
 * annotation's, and it lives at session level so it outlives the revision it was submitted on.
 */

export const canvasThreadSchema = z.object({
	id: z.string(),
	state: reviewThreadStateSchema,
	revision: z.number().int(),
	snippet: z.string(),
	canvasFile: z.string().optional(),
	filePath: z.string().optional(),
	comments: z.array(reviewCommentSchema),
	createdAt: z.string(),
	updatedAt: z.string(),
})
export type CanvasThread = z.infer<typeof canvasThreadSchema>

const threadsRecordSchema = z.object({ threads: z.array(canvasThreadSchema) })

const commentBody = z.string().trim().min(1).max(20_000)
export const agentReplyBodySchema = z.object({ body: commentBody, resolve: z.boolean() })
export const userReplyBodySchema = z.object({ body: commentBody })
export const resolvedBodySchema = z.object({ resolved: z.boolean() })

export class CanvasThreadStore {
	constructor(private readonly sessions: SessionManager, private readonly now: () => Date = () => new Date()) {}

	list(sessionId: string): readonly CanvasThread[] {
		this.requireSession(sessionId)
		const record = this.sessions.getThreads(sessionId)
		return record === null ? [] : threadsRecordSchema.parse(record).threads
	}

	/** The agent's answer, which opens the thread on its first reply. Without `resolve` it goes back to the user. */
	agentReply(sessionId: string, annotationId: string, body: string, resolve: boolean): CanvasThread {
		const threads = this.list(sessionId)
		const existing = threads.find((thread) => thread.id === annotationId)
		const thread = existing ?? this.opened(sessionId, annotationId)
		const next = agentReplied(thread, this.comment('agent', body), resolve)
		this.save(sessionId, existing ? threads.map((candidate) => (candidate.id === annotationId ? next : candidate)) : [...threads, next])
		return next
	}

	/** The user's answer goes to the agent and reopens a resolved thread. */
	userReply(sessionId: string, threadId: string, body: string): CanvasThread {
		return this.update(sessionId, threadId, (thread) => userCommented(thread, this.comment('user', body), true))
	}

	setResolved(sessionId: string, threadId: string, resolved: boolean): CanvasThread {
		return this.update(sessionId, threadId, (thread) => resolvedAs(thread, resolved, this.timestamp()))
	}

	/** Hands every thread the user answered to the agent, once. */
	claimQueued(sessionId: string): readonly CanvasThread[] {
		const result = claimed(this.list(sessionId), this.timestamp())
		if (result.claimed.length > 0) this.save(sessionId, result.threads)
		return result.claimed
	}

	private opened(sessionId: string, annotationId: string): CanvasThread {
		const submitted = this.sessions.findSubmittedAnnotation(sessionId, annotationId)
		if (submitted === null) throw new ReviewError(`No submitted annotation ${annotationId} in this session`, 404)
		const { annotation, revision } = submitted
		const createdAt = this.timestamp()
		const note = annotation.note.trim()
		return {
			id: annotation.id,
			// Delivered with the submit, so the agent already has it.
			state: 'working',
			revision,
			snippet: annotation.snippet,
			...(annotation.canvasFile === undefined ? {} : { canvasFile: annotation.canvasFile }),
			...(annotation.filePath === undefined ? {} : { filePath: annotation.filePath }),
			comments: note === '' ? [] : [{ id: Bun.randomUUIDv7(), author: 'user', body: note, createdAt }],
			createdAt,
			updatedAt: createdAt,
		}
	}

	private update(sessionId: string, threadId: string, change: (thread: CanvasThread) => CanvasThread): CanvasThread {
		const threads = this.list(sessionId)
		const current = threads.find((thread) => thread.id === threadId)
		if (current === undefined) throw new ReviewError(`No thread ${threadId}`, 404)
		const next = change(current)
		this.save(sessionId, threads.map((thread) => (thread.id === threadId ? next : thread)))
		return next
	}

	private save(sessionId: string, threads: readonly CanvasThread[]): void {
		this.sessions.saveThreads(sessionId, { threads })
	}

	private requireSession(sessionId: string): void {
		if (!this.sessions.get(sessionId)) throw new ReviewError('Session not found', 404)
	}

	private comment(author: ReviewAuthor, body: string): ReviewComment {
		return { id: Bun.randomUUIDv7(), author, body, createdAt: this.timestamp() }
	}

	private timestamp(): string {
		return this.now().toISOString()
	}
}

/** Threads the user answered, as the agent reads them: the annotation, the conversation, and how to reply. */
export function threadRepliesMarkdown(threads: readonly CanvasThread[]): string {
	const parts = ['## Thread replies', '']
	for (const thread of threads) {
		const where = thread.filePath ?? thread.canvasFile
		parts.push(`### Annotation \`${thread.id}\`${where ? ` in ${where}` : ''} (revision ${thread.revision})`, '')
		if (thread.snippet.trim()) parts.push(`> ${thread.snippet.trim().split('\n').join('\n> ')}`, '')
		for (const comment of thread.comments) {
			parts.push(`**${comment.author === 'agent' ? 'Agent' : 'User'}:** ${comment.body}`, '')
		}
	}
	parts.push('Answer each with `agent-canvas reply <annotation-id> "<text>"`; add `--resolve` when it is done.')
	return `${parts.join('\n')}\n`
}
