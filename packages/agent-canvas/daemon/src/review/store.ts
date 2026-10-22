import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
	isUnsentNote,
	PROJECT_RE,
	type ReviewAnchor,
	type ReviewAuthor,
	type ReviewProxy,
	reviewProxySchema,
	type ReviewThread,
	reviewThreadsFileSchema,
	type ReviewThreadState,
} from './model'

export class ReviewError extends Error {
	constructor(message: string, readonly status: 400 | 404 | 409) {
		super(message)
	}
}

/**
 * Review threads of each project: `<directory>/<project>/threads.json`, attached screenshots beside it, and the
 * project's review proxy in `proxy.json`.
 */
export class ReviewStore {
	constructor(private readonly directory: string, private readonly now: () => Date = () => new Date()) {}

	list(project: string): readonly ReviewThread[] {
		const path = join(this.projectDirectory(project), 'threads.json')
		if (!existsSync(path)) return []
		return reviewThreadsFileSchema.parse(JSON.parse(readFileSync(path, 'utf-8'))).threads
	}

	create(project: string, anchor: ReviewAnchor, body: string, send: boolean, screenshot?: Uint8Array): ReviewThread {
		const createdAt = this.timestamp()
		const id = Bun.randomUUIDv7()
		const thread: ReviewThread = {
			id,
			anchor,
			state: send ? 'queued' : 'open',
			comments: [{ id: Bun.randomUUIDv7(), author: 'user', body, createdAt }],
			...(screenshot === undefined ? {} : { screenshot: this.writeScreenshot(project, id, screenshot) }),
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

	/** Sends every unsent note at once, so the agent picks them up as one batch. */
	sendNotes(project: string): readonly ReviewThread[] {
		const threads = this.list(project)
		const updatedAt = this.timestamp()
		const sent = threads.filter(isUnsentNote).map((thread): ReviewThread => ({ ...thread, state: 'queued', updatedAt }))
		const sentById = new Map(sent.map((thread) => [thread.id, thread]))
		this.save(project, threads.map((thread) => sentById.get(thread.id) ?? thread))
		return sent
	}

	setResolved(project: string, threadId: string, resolved: boolean): ReviewThread {
		return this.update(project, threadId, (thread) => ({ ...thread, state: resolved ? 'resolved' : 'open', updatedAt: this.timestamp() }))
	}

	delete(project: string, threadId: string): void {
		const threads = this.list(project)
		const thread = threads.find((candidate) => candidate.id === threadId)
		if (thread === undefined) throw new ReviewError(`No thread ${threadId}`, 404)
		this.save(project, threads.filter((candidate) => candidate.id !== threadId))
		if (thread.screenshot !== undefined) rmSync(thread.screenshot, { force: true })
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

	proxyOf(project: string): ReviewProxy | undefined {
		const path = join(this.projectDirectory(project), 'proxy.json')
		if (!existsSync(path)) return undefined
		return reviewProxySchema.parse(JSON.parse(readFileSync(path, 'utf-8')))
	}

	saveProxy(project: string, proxy: ReviewProxy): void {
		this.writeJson(project, 'proxy.json', proxy)
	}

	/** Projects that have a review proxy, for a starting daemon to serve again. */
	proxiedProjects(): string[] {
		if (!existsSync(this.directory)) return []
		return readdirSync(this.directory).filter((name) => PROJECT_RE.test(name) && existsSync(join(this.directory, name, 'proxy.json')))
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

	private writeScreenshot(project: string, threadId: string, png: Uint8Array): string {
		const directory = join(this.projectDirectory(project), 'screenshots')
		mkdirSync(directory, { recursive: true })
		const path = join(directory, `${threadId}.png`)
		writeFileSync(path, png)
		return path
	}

	private save(project: string, threads: readonly ReviewThread[]): void {
		this.writeJson(project, 'threads.json', { threads })
	}

	private writeJson(project: string, file: string, value: unknown): void {
		const directory = this.projectDirectory(project)
		mkdirSync(directory, { recursive: true })
		const path = join(directory, file)
		const temporary = `${path}.${process.pid}.tmp`
		writeFileSync(temporary, `${JSON.stringify(value, null, '\t')}\n`)
		renameSync(temporary, path)
	}

	private projectDirectory(project: string): string {
		if (!PROJECT_RE.test(project)) throw new ReviewError(`Invalid project name ${project}`, 400)
		return join(this.directory, project)
	}

	private timestamp(): string {
		return this.now().toISOString()
	}
}
