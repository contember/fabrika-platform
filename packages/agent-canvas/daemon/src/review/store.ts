import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { PROJECT_RE, type ReviewAnchor, type ReviewAuthor, type ReviewThread, reviewThreadsFileSchema, type ReviewThreadState } from './model'

export class ReviewError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message)
	}
}

/** Review threads of each project, one JSON file per project under `directory`. */
export class ReviewStore {
	constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}

	list(project: string): readonly ReviewThread[] {
		const path = this.path(project)
		if (!existsSync(path)) return []
		return reviewThreadsFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8'))).threads
	}

	create(project: string, anchor: ReviewAnchor, body: string, send: boolean): ReviewThread {
		const createdAt = this.timestamp()
		const thread: ReviewThread = {
			id: Bun.randomUUIDv7(),
			anchor,
			state: send ? 'queued' : 'open',
			comments: [{ id: Bun.randomUUIDv7(), author: 'user', body, createdAt }],
			createdAt,
			updatedAt: createdAt,
		}
		this.save(project, [...this.list(project), thread])
		return thread
	}

	/** A comment from the person reopens a resolved thread; with `send` it goes to the agent. */
	addUserComment(project: string, threadId: string, body: string, send: boolean): ReviewThread {
		return this.update(project, threadId, (thread) => {
			const state: ReviewThreadState = send ? 'queued' : thread.state === 'resolved' ? 'open' : thread.state
			return { ...this.withComment(thread, 'user', body), state }
		})
	}

	send(project: string, threadId: string): ReviewThread {
		return this.update(project, threadId, (thread) => {
			if (thread.state === 'working') throw new ReviewError('The agent is already working on this thread', 409)
			return { ...thread, state: 'queued', updatedAt: this.timestamp() }
		})
	}

	setResolved(project: string, threadId: string, resolved: boolean): ReviewThread {
		return this.update(project, threadId, (thread) => ({ ...thread, state: resolved ? 'resolved' : 'open', updatedAt: this.timestamp() }))
	}

	delete(project: string, threadId: string): void {
		const threads = this.list(project)
		if (!threads.some((thread) => thread.id === threadId)) throw new ReviewError(`No thread ${threadId}`, 404)
		this.save(project, threads.filter((thread) => thread.id !== threadId))
	}

	/** Hands every queued thread to the agent: they become `working` and are returned in creation order. */
	claimQueued(project: string): readonly ReviewThread[] {
		const threads = this.list(project)
		const claimed = threads.filter((thread) => thread.state === 'queued')
		if (claimed.length === 0) return []
		const updatedAt = this.timestamp()
		const claimedIds = new Set(claimed.map((thread) => thread.id))
		this.save(project, threads.map((thread) => (claimedIds.has(thread.id) ? { ...thread, state: 'working', updatedAt } : thread)))
		return claimed.map((thread) => ({ ...thread, state: 'working', updatedAt }))
	}

	/** The agent's answer. Without `resolve` the thread goes back to the person as `open`. */
	agentReply(project: string, threadId: string, body: string, resolve: boolean): ReviewThread {
		return this.update(project, threadId, (thread) => ({ ...this.withComment(thread, 'agent', body), state: resolve ? 'resolved' : 'open' }))
	}

	private update(project: string, threadId: string, change: (thread: ReviewThread) => ReviewThread): ReviewThread {
		const threads = this.list(project)
		const current = threads.find((thread) => thread.id === threadId)
		if (current === undefined) throw new ReviewError(`No thread ${threadId}`, 404)
		const next = change(current)
		this.save(project, threads.map((thread) => (thread.id === threadId ? next : thread)))
		return next
	}

	private withComment(thread: ReviewThread, author: ReviewAuthor, body: string): ReviewThread {
		const createdAt = this.timestamp()
		return { ...thread, comments: [...thread.comments, { id: Bun.randomUUIDv7(), author, body, createdAt }], updatedAt: createdAt }
	}

	private save(project: string, threads: readonly ReviewThread[]): void {
		mkdirSync(this.directory, { recursive: true })
		const path = this.path(project)
		const temporary = `${path}.${process.pid}.tmp`
		writeFileSync(temporary, `${JSON.stringify({ threads }, null, '\t')}\n`)
		renameSync(temporary, path)
	}

	private path(project: string): string {
		if (!PROJECT_RE.test(project)) throw new ReviewError(`Invalid project name ${project}`, 400)
		return join(this.directory, `${project}.json`)
	}

	private timestamp(): string {
		return this.now().toISOString()
	}
}
