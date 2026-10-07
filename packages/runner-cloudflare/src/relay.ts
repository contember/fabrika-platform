// The Worker→container run relay — the testable core of vozka-runner's `startRun`, decoupled from the
// real DO so it can be unit-tested with fakes (no Cloudflare, no Docker).
//
// Given a started container stub and an R2-like bucket, it POSTs the provider job to `/run`, tails
// the `/logs` NDJSON stream relaying every line to R2 (full accumulated log re-flushed under one
// run-keyed object), then polls `/status` for the terminal outcome and persists that too.

import type { RunLogLine } from '@fabrika/control-contract'
import { type CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import { RUNNER_HEALTH_PATH, RUNNER_LOGS_PATH, RUNNER_RUN_PATH, RUNNER_STATUS_PATH, type RunnerStatus } from '@fabrika/runner-contract'
import { z } from 'zod'
import { parseRunLogLine, parseRunnerStatus, runnerHealthSchema, stampDryRun } from './protocol'

/** The slice of a Cloudflare R2 bucket the relay needs. Real `R2Bucket` satisfies this. */
export interface R2Like {
	put: (key: string, value: string) => Promise<unknown>
}

/** The slice of a started container DO stub the relay needs. `RunnerContainer` satisfies this. */
export interface ContainerLike {
	containerFetch: (input: string, init?: RequestInit) => Promise<Response>
	/** Renew the container's activity timeout (heartbeat) so a quiet long step isn't reaped. */
	heartbeat?: () => Promise<void> | void
}

/** Where a run's artifacts live in R2 (keyed by run id). */
export const logsKey = (runId: string): string => `runs/${runId}/logs.ndjson`
export const statusKey = (runId: string): string => `runs/${runId}/status.json`

/** The relay's outcome: the terminal status (also persisted to R2). */
export interface RelayResult {
	status: RunnerStatus
	/** Total log lines relayed. */
	lineCount: number
}

export interface RelayOptions {
	/** Re-flush the accumulated log to R2 at most this often (ms). Defaults to 2000. */
	flushIntervalMs?: number
	/** Poll `/status` until terminal, at this interval (ms). Defaults to 500. */
	statusPollMs?: number
	/** Deadline for the read-only image probe, including its response body. Defaults to 15 seconds. */
	healthTimeoutMs?: number
	/** Clock, injectable for tests. Defaults to `Date.now`. */
	now?: () => number
}

const MAX_HEALTH_BYTES = 4096
const SOURCE_PROTOCOL_FAILURE = 'runner source protocol is unavailable or not supported'
const healthTimeoutSchema = z.number().finite().positive().max(120_000)

const assertImageSourceProtocol = async (container: ContainerLike, timeoutMs: number): Promise<void> => {
	const expired = Promise.withResolvers<never>()
	const deadline = Date.now() + timeoutMs
	let timedOut = false
	const timer = setTimeout(() => {
		timedOut = true
		expired.reject(new Error(SOURCE_PROTOCOL_FAILURE))
	}, timeoutMs)
	let response: Response | undefined
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
	try {
		// deployFetch is a DO RPC: bound its read-only wait here, without serializing an AbortSignal.
		const request = container.containerFetch(`http://container${RUNNER_HEALTH_PATH}`, { redirect: 'manual' })
		void request.then((late) => {
			if (timedOut) void late.body?.cancel().catch(() => {})
		}, () => {})
		response = await Promise.race([request, expired.promise])
		if (response.status !== 200 || response.redirected || response.body === null) {
			throw new Error(SOURCE_PROTOCOL_FAILURE)
		}
		reader = response.body.getReader()
		const decoder = new TextDecoder('utf-8', { fatal: true })
		let bytes = 0
		let body = ''
		for (;;) {
			if (Date.now() >= deadline) throw new Error(SOURCE_PROTOCOL_FAILURE)
			const chunk = await Promise.race([reader.read(), expired.promise])
			if (chunk.done) break
			bytes += chunk.value.byteLength
			if (bytes > MAX_HEALTH_BYTES) throw new Error(SOURCE_PROTOCOL_FAILURE)
			body += decoder.decode(chunk.value, { stream: true })
		}
		body += decoder.decode()
		const health: unknown = JSON.parse(body)
		if (Date.now() >= deadline || !runnerHealthSchema.safeParse(health).success) throw new Error(SOURCE_PROTOCOL_FAILURE)
	} catch {
		if (reader !== undefined) void reader.cancel().catch(() => {})
		else void response?.body?.cancel().catch(() => {})
		throw new Error(SOURCE_PROTOCOL_FAILURE)
	} finally {
		clearTimeout(timer)
		reader?.releaseLock()
	}
}

/** Parse a newline-delimited JSON log stream chunk-by-chunk, invoking `onLine` per complete line. */
const streamLines = async (response: Response, onLine: (line: RunLogLine) => void): Promise<void> => {
	if (response.body === null) {
		return
	}
	const reader = response.body.getReader()
	const decoder = new TextDecoder()
	let pending = ''
	for (;;) {
		const { done, value } = await reader.read()
		if (done) {
			break
		}
		pending += decoder.decode(value, { stream: true })
		let newline = pending.indexOf('\n')
		while (newline !== -1) {
			const raw = pending.slice(0, newline)
			pending = pending.slice(newline + 1)
			if (raw.length > 0) {
				const line = parseRunLogLine(raw)
				onLine(line)
			}
			newline = pending.indexOf('\n')
		}
	}
	if (pending.trim().length > 0) {
		const line = parseRunLogLine(pending)
		onLine(line)
	}
}

/**
 * Run the relay against an already-started container. Resolves once the run is terminal, after the
 * final log flush and the status object are persisted to R2.
 */
export const relayRun = async (
	container: ContainerLike,
	bucket: R2Like,
	job: CloudflareRunnerJob,
	options: RelayOptions = {},
): Promise<RelayResult> => {
	const flushIntervalMs = options.flushIntervalMs ?? 2000
	const statusPollMs = options.statusPollMs ?? 500
	const now = options.now ?? (() => Date.now())
	const healthTimeoutMs = options.healthTimeoutMs ?? 15_000
	if (!healthTimeoutSchema.safeParse(healthTimeoutMs).success) {
		throw new Error('runner health timeout must be greater than 0 and at most 120000 milliseconds')
	}
	const startedAt = now()
	try {
		await assertImageSourceProtocol(container, healthTimeoutMs)
	} catch {
		const finishedAt = now()
		const status = stampDryRun({ runId: job.runId, state: 'failed', error: SOURCE_PROTOCOL_FAILURE, startedAt, finishedAt }, job.dryRun === true)
		const line: RunLogLine = { ts: finishedAt, stream: 'meta', text: SOURCE_PROTOCOL_FAILURE }
		for (
			const diagnostic of [
				{ key: logsKey(job.runId), value: JSON.stringify(line), kind: 'log' },
				{ key: statusKey(job.runId), value: JSON.stringify(status), kind: 'status' },
			]
		) {
			try {
				await bucket.put(diagnostic.key, diagnostic.value)
			} catch {
				console.error(`runner: failed to persist source protocol refusal ${diagnostic.kind}`)
			}
		}
		return { status, lineCount: 1 }
	}

	// Kick off the run — WITHOUT the runner key. It authenticates control to THIS Worker and stops here;
	// the container runs the checkout's own code as root, so anything it receives is disclosed to it.
	const { runnerKey: _runnerKey, ...containerJob } = job
	const start = await container.containerFetch(`http://container${RUNNER_RUN_PATH}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(containerJob),
	})
	if (start.status !== 202) {
		const detail = await start.text().catch(() => '')
		throw new Error(`runner rejected /run: ${start.status} ${detail}`.trim())
	}

	// Tail logs, accumulating the full NDJSON and re-flushing it to R2 periodically.
	const accumulated: string[] = []
	let lastFlush = 0
	let pendingFlush = false
	let writer: Promise<void> | undefined
	let writeFailure: { error: unknown } | undefined
	const writeSnapshots = async (): Promise<void> => {
		try {
			while (pendingFlush) {
				pendingFlush = false
				try {
					await bucket.put(logsKey(job.runId), accumulated.join('\n'))
				} catch (error) {
					writeFailure ??= { error }
				}
			}
		} finally {
			writer = undefined
		}
	}
	const requestFlush = (force: boolean): void => {
		const ts = now()
		if (!force && ts - lastFlush < flushIntervalMs) {
			return
		}
		lastFlush = ts
		pendingFlush = true
		writer ??= Promise.resolve().then(writeSnapshots)
	}

	// Heartbeat on a timer so even an output-quiet step (e.g. `bun install`) renews the activity
	// timeout. Each relayed line also heartbeats, covering the common chatty case.
	const heartbeat = (): void => {
		void container.heartbeat?.()
	}
	const heartbeatTimer = setInterval(heartbeat, flushIntervalMs)

	try {
		const logs = await container.containerFetch(`http://container${RUNNER_LOGS_PATH}`)
		await streamLines(logs, (line) => {
			accumulated.push(JSON.stringify(line))
			heartbeat()
			requestFlush(false)
		})
	} finally {
		clearInterval(heartbeatTimer)
		await writer
	}
	// Final log flush once the stream closes (the container closes /logs at terminal state).
	requestFlush(true)
	await writer
	// A recovered final snapshot must not hide an earlier persistence failure from the caller.
	if (writeFailure !== undefined) {
		throw writeFailure.error
	}

	// Read the terminal status (poll in case the stream closed a hair before status settled).
	let status: RunnerStatus | undefined
	for (;;) {
		const response = await container.containerFetch(`http://container${RUNNER_STATUS_PATH}`)
		const parsed = parseRunnerStatus(await response.json().catch(() => undefined), job.runId)
		if (parsed.state === 'succeeded' || parsed.state === 'failed') {
			status = stampDryRun(parsed, job.dryRun === true)
			break
		}
		await new Promise((resolve) => setTimeout(resolve, statusPollMs))
	}

	await bucket.put(statusKey(job.runId), JSON.stringify(status))
	return { status, lineCount: accumulated.length }
}
