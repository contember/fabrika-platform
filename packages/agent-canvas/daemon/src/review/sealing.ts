import { decryptString, encryptString } from '../../client/shareCrypto'
import { type ReviewAnchor, reviewAnchorSchema, type ReviewThread, reviewThreadSchema } from './model'
import type { SealedThread } from './remote'

/** What the reviewer's browser and the agent's CLI seal before a remote project's worker sees it, and open after. */

export function sealAnchor(key: CryptoKey, anchor: ReviewAnchor): Promise<string> {
	return encryptString(key, JSON.stringify(anchor))
}

export function sealText(key: CryptoKey, text: string): Promise<string> {
	return encryptString(key, text)
}

export function openText(key: CryptoKey, sealed: string): Promise<string> {
	return decryptString(key, sealed)
}

/**
 * Opens a thread into the shape the widget and the agent read. A thread that does not decrypt with the key or does not
 * parse once open was not sealed by this project's browser or CLI; it throws.
 */
export async function openThread(key: CryptoKey, thread: SealedThread, screenshot?: string): Promise<ReviewThread> {
	const anchor: unknown = JSON.parse(await decryptString(key, thread.anchor))
	const comments = await Promise.all(thread.comments.map(async (comment) => ({ ...comment, body: await decryptString(key, comment.body) })))
	return reviewThreadSchema.parse({
		id: thread.id,
		anchor: reviewAnchorSchema.parse(anchor),
		state: thread.state,
		comments,
		...(screenshot === undefined ? {} : { screenshot }),
		createdAt: thread.createdAt,
		updatedAt: thread.updatedAt,
	})
}
