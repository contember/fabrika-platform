import type { IngestMessage, ParsedEvent } from '@fabrika/operations-contract'
import type { BlobStore, JobQueue } from '@fabrika/platform'
import { issueCulprit, issueTitle, resolveFingerprint, sha256Hex } from './ingest.js'
import type { OperationsRepositories, RecordOccurrenceResult } from './repositories.js'
import { frameBasename } from './source-maps.js'
import { uuidv7 } from './uuid.js'

export interface OperationsDataEnv {
	repositories: OperationsRepositories
	payloads: BlobStore
	ingestQueue: JobQueue<IngestMessage>
}

export async function credentialVerifier(publicKey: string): Promise<string> {
	return sha256Hex(publicKey)
}

export async function prepareIngestMessage(sourceId: string, parsed: ParsedEvent): Promise<IngestMessage> {
	const fingerprint = await resolveFingerprint(parsed)
	const message: IngestMessage = {
		projectId: sourceId,
		fingerprint,
		eventId: parsed.eventId,
		title: issueTitle(parsed.exception),
		culprit: issueCulprit(parsed.exception),
		level: parsed.level,
		receivedAt: parsed.receivedAt,
		payload: parsed.raw,
	}
	if (parsed.release !== undefined) message.release = parsed.release
	if (parsed.environment !== undefined) message.environment = parsed.environment
	return message
}

export async function enqueueIngest(env: OperationsDataEnv, message: IngestMessage): Promise<void> {
	await env.ingestQueue.send(message)
}

export function eventBlobKey(message: IngestMessage): string {
	const reverseTime = (9_999_999_999_999 - message.receivedAt).toString().padStart(13, '0')
	return `events/${message.projectId}/${message.fingerprint}/${reverseTime}_${message.eventId}.json`
}

export async function effectiveIngestMessage(env: Pick<OperationsDataEnv, 'repositories'>, message: IngestMessage): Promise<IngestMessage> {
	const fingerprint = await env.repositories.issues.canonicalFingerprint(message.projectId, message.fingerprint)
	return fingerprint === message.fingerprint ? message : { ...message, fingerprint }
}

export async function persistIngest(env: OperationsDataEnv, message: IngestMessage): Promise<RecordOccurrenceResult> {
	const effective = await effectiveIngestMessage(env, message)
	const blobKey = eventBlobKey(effective)
	await env.payloads.put(blobKey, JSON.stringify(effective.payload))
	return env.repositories.ingest.record({
		sourceId: effective.projectId,
		fingerprint: effective.fingerprint,
		eventId: effective.eventId,
		title: effective.title,
		culprit: effective.culprit,
		level: effective.level,
		release: effective.release ?? null,
		receivedAt: effective.receivedAt,
		blobKey,
	})
}

export async function persistIngestGroup(
	env: OperationsDataEnv,
	messages: IngestMessage[],
): Promise<RecordOccurrenceResult[]> {
	if (messages.length === 0) return []
	if (messages.length > 50) throw new RangeError('ingest group exceeds 50 events')
	const first = messages[0]
	if (!first) return []
	if (messages.some((message) => message.projectId !== first.projectId || message.fingerprint !== first.fingerprint)) {
		throw new Error('ingest group must share one source and effective fingerprint')
	}
	const inputs = messages.map((message) => {
		const blobKey = eventBlobKey(message)
		return {
			sourceId: message.projectId,
			fingerprint: message.fingerprint,
			eventId: message.eventId,
			title: message.title,
			culprit: message.culprit,
			level: message.level,
			release: message.release ?? null,
			receivedAt: message.receivedAt,
			blobKey,
		}
	})
	await Promise.all(messages.map((message) => env.payloads.put(eventBlobKey(message), JSON.stringify(message.payload))))
	return env.repositories.ingest.recordGroup(inputs)
}

export async function archiveDeadEvent(
	env: Pick<OperationsDataEnv, 'payloads' | 'repositories'>,
	message: IngestMessage,
	input: { attempts: number; reason: string; deadAt?: number },
): Promise<void> {
	const deadAt = input.deadAt ?? Date.now()
	const blobKey = `dead/${message.projectId}/${message.eventId}.json`
	await env.payloads.put(blobKey, JSON.stringify(message))
	await env.repositories.deadEvents.record({
		id: uuidv7(deadAt),
		sourceId: message.projectId,
		eventId: message.eventId,
		fingerprint: message.fingerprint,
		blobKey,
		reason: input.reason,
		attempts: input.attempts,
		deadAt,
	})
}

export async function storeSourceMap(
	env: Pick<OperationsDataEnv, 'payloads' | 'repositories'>,
	input: { sourceId: string; releaseId: string; fileName: string; body: string },
): Promise<string> {
	const fileName = frameBasename(input.fileName)
	if (!fileName) throw new Error('source map file name is empty')
	if (!(await env.repositories.artifacts.releaseBelongsToSource(input.sourceId, input.releaseId))) {
		throw new Error('release does not belong to source')
	}
	const blobKey = `source-maps/${input.sourceId}/${input.releaseId}/${fileName}.map`
	await env.payloads.put(blobKey, input.body)
	await env.repositories.artifacts.indexSourceMap({ releaseId: input.releaseId, fileName, blobKey })
	return blobKey
}
