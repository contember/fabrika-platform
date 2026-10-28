import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { exportShareKey, generateShareKey, importShareKey } from '../../../daemon/client/shareCrypto.ts'
import { REVIEWS_DIR } from '../../../daemon/src/paths.ts'
import { renderReviewRequests } from '../../../daemon/src/review/markdown.ts'
import { type ReviewThread, screenshotDataUrlSchema } from '../../../daemon/src/review/model.ts'
import {
	AGENT_SOCKET_PROTOCOL,
	createRemoteProjectResponseSchema,
	formatReviewCredentials,
	KEEPALIVE_PING,
	REMOTE_PROJECT_ID_RE,
	REVIEW_FRAGMENT_PARAM,
	sealedScreenshotSchema,
	type SealedThread,
	sealedThreadSchema,
	sealedThreadsSchema,
} from '../../../daemon/src/review/remote.ts'
import { openText, openThread, sealText } from '../../../daemon/src/review/sealing.ts'
import { loadShareConfig } from '../../../daemon/src/share.ts'
import { VERSION } from '../config.ts'

const KEEPALIVE_MS = 30_000

/**
 * A remote review project as this machine knows it: where it lives, the key that seals its threads and the token that
 * lets the agent claim and answer them. Both secrets stay in this file; the worker holds only the token's hash.
 */
const remoteReviewSchema = z.object({
	endpoint: z.string().url(),
	projectId: z.string().regex(REMOTE_PROJECT_ID_RE),
	key: z.string(),
	agentToken: z.string(),
	appUrl: z.string().url(),
})
export type RemoteReview = z.infer<typeof remoteReviewSchema>

const errorSchema = z.object({ error: z.string() })
const threadResponseSchema = z.object({ thread: sealedThreadSchema })

function projectDirectory(project: string): string {
	return join(REVIEWS_DIR, project)
}

function remoteFile(project: string): string {
	return join(projectDirectory(project), 'remote.json')
}

export function loadRemoteReview(project: string): RemoteReview | undefined {
	const path = remoteFile(project)
	if (!existsSync(path)) return undefined
	return remoteReviewSchema.parse(JSON.parse(readFileSync(path, 'utf-8')))
}

/** Creates the project on the share worker for the application at `appUrl` and keeps its secrets on this machine. */
export async function createRemoteReview(project: string, appUrl: URL): Promise<RemoteReview> {
	const config = loadShareConfig(VERSION)
	if (config === null) throw new Error('Set CANVAS_SHARE_ENDPOINT to the share worker that keeps remote reviews')
	const response = await fetch(`${config.endpoint}/reviews`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...(config.authToken === undefined ? {} : { Authorization: `Bearer ${config.authToken}` }) },
		body: JSON.stringify({ origins: [appUrl.origin] }),
	})
	const body: unknown = await response.json()
	if (!response.ok) {
		const error = errorSchema.safeParse(body)
		throw new Error(`The share worker refused the review project: ${error.success ? error.data.error : response.status}`)
	}
	const created = createRemoteProjectResponseSchema.parse(body)
	const remote: RemoteReview = {
		endpoint: config.endpoint,
		projectId: created.projectId,
		key: await exportShareKey(await generateShareKey()),
		agentToken: created.agentToken,
		appUrl: appUrl.href,
	}
	mkdirSync(projectDirectory(project), { recursive: true })
	writeFileSync(remoteFile(project), `${JSON.stringify(remote, null, '\t')}\n`, { mode: 0o600 })
	chmodSync(remoteFile(project), 0o600)
	return remote
}

/** The address the reviewer opens: the application, with the project and its key in the fragment. */
export function reviewerLink(remote: RemoteReview): string {
	const app = new URL(remote.appUrl)
	app.hash = `${REVIEW_FRAGMENT_PARAM}=${formatReviewCredentials({ projectId: remote.projectId, key: remote.key })}`
	return app.href
}

export function remoteSnippet(remote: RemoteReview): string {
	return `<script src="${remote.endpoint}/assets/review.js" defer></script>`
}

/** The agent's side of a remote project: every request carries the agent token, every thread is opened here. */
export class RemoteReviewBackend {
	private key: Promise<CryptoKey> | null = null

	constructor(private readonly project: string, private readonly remote: RemoteReview) {}

	get waitUrl(): string {
		return `${this.remote.endpoint.replace(/^http/, 'ws')}/review/${this.remote.projectId}/agent/ws`
	}

	/** The agent's wait socket; it pings so an idle connection stays open between batches. */
	createSocket(url: string): WebSocket {
		const socket = new WebSocket(url, [AGENT_SOCKET_PROTOCOL, this.remote.agentToken])
		let keepalive: ReturnType<typeof setInterval> | null = null
		socket.addEventListener('open', () => {
			keepalive = setInterval(() => socket.send(KEEPALIVE_PING), KEEPALIVE_MS)
		})
		socket.addEventListener('close', () => {
			if (keepalive !== null) clearInterval(keepalive)
		})
		return socket
	}

	/** Takes the sent threads, as markdown, or `undefined` when none are waiting. */
	async claim(): Promise<string | undefined> {
		const { threads } = sealedThreadsSchema.parse(await this.call('POST', '/claim'))
		if (threads.length === 0) return undefined
		const opened: ReviewThread[] = []
		const unreadable: string[] = []
		for (const thread of threads) {
			try {
				opened.push(await this.open(thread, true))
			} catch {
				unreadable.push(thread.id)
			}
		}
		const markdown = opened.length === 0 ? '' : renderReviewRequests(this.project, opened)
		if (unreadable.length === 0) return markdown
		return `${markdown}\nThese threads did not open with this project's key, so they were not sealed by its reviewers: ${unreadable.join(', ')}\n`
	}

	async threads(): Promise<ReviewThread[]> {
		const { threads } = sealedThreadsSchema.parse(await this.call('GET', '/threads'))
		const opened = await Promise.allSettled(threads.map((thread) => this.open(thread, false)))
		return opened.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
	}

	async reply(threadId: string, body: string, resolve: boolean): Promise<void> {
		threadResponseSchema.parse(
			await this.call('POST', `/threads/${encodeURIComponent(threadId)}/reply`, { body: await sealText(await this.cryptoKey(), body), resolve }),
		)
	}

	private async open(thread: SealedThread, withScreenshot: boolean): Promise<ReviewThread> {
		const key = await this.cryptoKey()
		const screenshot = withScreenshot && thread.screenshot ? await this.saveScreenshot(key, thread.id) : undefined
		return openThread(key, thread, screenshot)
	}

	/** Writes the reviewer's screenshot where the agent can read it, as the daemon does for local threads. */
	private async saveScreenshot(key: CryptoKey, threadId: string): Promise<string> {
		const { screenshot } = sealedScreenshotSchema.parse(await this.call('GET', `/threads/${encodeURIComponent(threadId)}/screenshot`))
		const png = screenshotDataUrlSchema.parse(await openText(key, screenshot))
		const directory = join(projectDirectory(this.project), 'screenshots')
		mkdirSync(directory, { recursive: true })
		const path = join(directory, `${threadId}.png`)
		writeFileSync(path, png)
		return path
	}

	private cryptoKey(): Promise<CryptoKey> {
		this.key ??= importShareKey(this.remote.key)
		return this.key
	}

	private async call(method: string, path: string, body?: unknown): Promise<unknown> {
		const response = await fetch(`${this.remote.endpoint}/review/${this.remote.projectId}/agent${path}`, {
			method,
			headers: {
				Authorization: `Bearer ${this.remote.agentToken}`,
				...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		const result: unknown = await response.json()
		if (!response.ok) {
			const error = errorSchema.safeParse(result)
			throw new Error(error.success ? error.data.error : `The share worker answered ${response.status}`)
		}
		return result
	}
}
