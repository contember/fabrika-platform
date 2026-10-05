import type { RunLogLine } from '@fabrika/control-contract'
import { CLOUDFLARE_SOURCE_PROTOCOL, type CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import type { RunnerStatus } from '@fabrika/runner-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { type ContainerLike, logsKey, type R2Like, relayRun, statusKey } from '../relay'

// The relay is the testable core of vozka-runner's `startRun`. These tests drive it against a FAKE
// container (its /run, /logs, /status endpoints) and a FAKE R2 — no Cloudflare, no Docker. This is the
// part of the Worker↔DO path we can verify offline; the real DO + container provisioning is CF-only.

/** An in-memory R2 stand-in capturing the last value written per key. */
class FakeR2 implements R2Like {
	readonly objects = new Map<string, string>()
	async put(key: string, value: string): Promise<void> {
		this.objects.set(key, value)
	}
}

const ndjson = (lines: RunLogLine[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

const sampleLines: RunLogLine[] = [
	{ ts: 1, stream: 'meta', text: 'Cloning https://github.com/acme/app.git @ main' },
	{ ts: 2, stream: 'stdout', text: 'bun install: done' },
	{ ts: 3, stream: 'stdout', text: 'sample → stage: succeeded' },
]

/** A fake started container exposing the three protocol endpoints. */
const makeContainer = (status: RunnerStatus, lines: RunLogLine[], heartbeats: { count: number }): ContainerLike => ({
	heartbeat: () => {
		heartbeats.count++
	},
	containerFetch: async (input: string, init?: RequestInit): Promise<Response> => {
		const url = new URL(input)
		if (url.pathname === '/health') {
			return new Response(JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }))
		}
		if (init?.method === 'POST' && url.pathname === '/run') {
			return new Response(JSON.stringify({ runId: status.runId, accepted: true }), { status: 202 })
		}
		if (url.pathname === '/logs') {
			return new Response(ndjson(lines), { headers: { 'content-type': 'application/x-ndjson' } })
		}
		if (url.pathname === '/status') {
			return new Response(JSON.stringify(status), { headers: { 'content-type': 'application/json' } })
		}
		return new Response('not found', { status: 404 })
	},
})

const job: CloudflareRunnerJob = {
	runId: 'run-relay-1',
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'stage',
	runnerKey: 'test-runner-key',
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' },
}

const terminalStatus: RunnerStatus = { runId: 'run-relay-1', state: 'succeeded', exitCode: 0, startedAt: 1, finishedAt: 9 }

const makeStreamingContainer = async (heartbeat: () => void = () => {}): Promise<{
	container: ContainerLike
	logs: ReadableStreamDefaultController<Uint8Array>
}> => {
	const controller = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>()
	const stream = new ReadableStream<Uint8Array>({ start: controller.resolve })
	const inner = makeContainer(terminalStatus, [], { count: 0 })
	return {
		container: {
			heartbeat,
			containerFetch: (input, init) => new URL(input).pathname === '/logs' ? Promise.resolve(new Response(stream)) : inner.containerFetch(input, init),
		},
		logs: await controller.promise,
	}
}

describe('relayRun', () => {
	test('requests manual redirect handling and refuses a redirect before the DO response can lose its history', async () => {
		const paths: string[] = []
		const bucket = new FakeR2()
		const result = await relayRun(
			{
				containerFetch: async (input, init) => {
					paths.push(new URL(input).pathname)
					expect(init).toEqual({ redirect: 'manual' })
					expect(new Request(input, init).redirect).toBe('manual')
					const response = new Response(JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }), {
						status: 302,
						headers: { location: 'http://container/capable' },
					})
					expect(response.redirected).toBe(false)
					return response
				},
			},
			bucket,
			job,
		)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
		expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(result.status))
	})

	for (const failedWrites of [[logsKey(job.runId)], [statusKey(job.runId)], [logsKey(job.runId), statusKey(job.runId)]]) {
		test(`known image refusal survives diagnostic persistence failure: ${failedWrites.join(', ')}`, async () => {
			const paths: string[] = []
			const attempts: string[] = []
			const bucket = new FakeR2()
			const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
			try {
				const result = await relayRun({
					containerFetch: async (input) => {
						paths.push(new URL(input).pathname)
						return new Response(JSON.stringify({ status: 'ok', port: 8080 }))
					},
				}, {
					put: async (key, value) => {
						attempts.push(key)
						if (failedWrites.includes(key)) throw new Error('R2 error contains private-storage-token')
						await bucket.put(key, value)
					},
				}, job)
				expect(paths).toEqual(['/health'])
				expect(attempts).toEqual([logsKey(job.runId), statusKey(job.runId)])
				expect(result.status.state).toBe('failed')
				expect(result.status.error).toBe('runner source protocol is unavailable or not supported')
				expect(result.lineCount).toBe(1)
				expect(diagnostic.mock.calls).toEqual(failedWrites.map((key) => [
					`runner: failed to persist source protocol refusal ${key === logsKey(job.runId) ? 'log' : 'status'}`,
				]))
				expect(JSON.stringify(result) + JSON.stringify(diagnostic.mock.calls) + [...bucket.objects.values()].join('\n'))
					.not.toContain('private-storage-token')
			} finally {
				diagnostic.mockRestore()
			}
		})
	}

	for (
		const body of [
			JSON.stringify({ status: 'ok', port: 8080 }),
			JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: 'branch-v0' }),
			JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: 1 }),
			JSON.stringify({ status: 'ok', port: '8080', sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }),
			JSON.stringify({ status: false, port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }),
			JSON.stringify([CLOUDFLARE_SOURCE_PROTOCOL]),
			'null',
			'{ malformed health: private-image-token',
		]
	) {
		test(`refuses unsupported or malformed image health before POST: ${body}`, async () => {
			const paths: string[] = []
			const bucket = new FakeR2()
			const result = await relayRun(
				{
					containerFetch: async (input, init) => {
						paths.push(new URL(input).pathname)
						expect(init).toEqual({ redirect: 'manual' })
						return new Response(body)
					},
				},
				bucket,
				job,
				{ now: () => 10 },
			)
			expect(paths).toEqual(['/health'])
			expect(result).toEqual({
				status: { runId: job.runId, state: 'failed', error: 'runner source protocol is unavailable or not supported', startedAt: 10, finishedAt: 10 },
				lineCount: 1,
			})
			expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(result.status))
			expect(bucket.objects.get(logsKey(job.runId))).toBe(JSON.stringify({ ts: 10, stream: 'meta', text: result.status.error }))
			expect([...bucket.objects.values()].join('\n')).not.toContain('private-image-token')
		})
	}

	test('unavailable image health settles known undispatched failure with a fixed persisted summary', async () => {
		for (const failure of ['reject', 'status']) {
			const paths: string[] = []
			const bucket = new FakeR2()
			const result = await relayRun(
				{
					containerFetch: async (input) => {
						paths.push(new URL(input).pathname)
						if (failure === 'reject') throw new Error('transport contains private-image-token')
						return new Response('private-image-token', { status: 503 })
					},
				},
				bucket,
				job,
			)
			expect(paths).toEqual(['/health'])
			expect(result.status.state).toBe('failed')
			expect([...bucket.objects.values()].join('\n')).not.toContain('private-image-token')
			expect(bucket.objects.size).toBe(2)
		}
	})

	test('bounds an outstanding read-only DO RPC locally without passing an AbortSignal', async () => {
		const response = Promise.withResolvers<Response>()
		const paths: string[] = []
		const bucket = new FakeR2()
		const result = await relayRun(
			{
				containerFetch: (input, init) => {
					paths.push(new URL(input).pathname)
					expect(init).toEqual({ redirect: 'manual' })
					return response.promise
				},
			},
			bucket,
			job,
			{ healthTimeoutMs: 10 },
		)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
		let cancelled = false
		response.resolve(
			new Response(
				new ReadableStream<Uint8Array>({
					cancel: () => {
						cancelled = true
					},
				}),
			),
		)
		await Bun.sleep(0)
		expect(cancelled).toBe(true)
		expect(paths).toEqual(['/health'])
		expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(result.status))
	})

	test('the deadline includes a stalled health body, even when cancelling that body never completes', async () => {
		const paths: string[] = []
		let cancelled = false
		const bucket = new FakeR2()
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) =>
				controller.enqueue(new TextEncoder().encode(JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }))),
			cancel: () => {
				cancelled = true
				return new Promise(() => {})
			},
		})
		const result = await relayRun(
			{
				containerFetch: async (input) => {
					paths.push(new URL(input).pathname)
					return new Response(stream)
				},
			},
			bucket,
			job,
			{ healthTimeoutMs: 10 },
		)
		expect(result.status.state).toBe('failed')
		expect(cancelled).toBe(true)
		expect(paths).toEqual(['/health'])
		expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(result.status))
	})

	test('caps actual health bytes across chunks, independent of Content-Length', async () => {
		const paths: string[] = []
		const bucket = new FakeR2()
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(' '.repeat(2048)))
				controller.enqueue(new TextEncoder().encode(' '.repeat(2049)))
				controller.close()
			},
		})
		const result = await relayRun(
			{
				containerFetch: async (input) => {
					paths.push(new URL(input).pathname)
					return new Response(stream, { headers: { 'content-length': '1' } })
				},
			},
			bucket,
			job,
		)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
		expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(result.status))
	})

	test('the health byte cap counts UTF-8 bytes, not decoded characters', async () => {
		const paths: string[] = []
		const body = JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL, padding: '€'.repeat(2000) })
		expect(body.length).toBeLessThan(4096)
		const result = await relayRun(
			{
				containerFetch: async (input) => {
					paths.push(new URL(input).pathname)
					return new Response(body)
				},
			},
			new FakeR2(),
			job,
		)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
	})

	test('continuously ready empty chunks cannot starve the health deadline', async () => {
		const paths: string[] = []
		const body = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array()) })
		const result = await relayRun(
			{
				containerFetch: async (input) => {
					paths.push(new URL(input).pathname)
					return new Response(body)
				},
			},
			new FakeR2(),
			job,
			{ healthTimeoutMs: 10 },
		)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
	})

	test('a complete typed health body at the byte limit admits the job', async () => {
		const inner = makeContainer(terminalStatus, [], { count: 0 })
		const health = JSON.stringify({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL })
		const paths: string[] = []
		const result = await relayRun(
			{
				containerFetch: (input, init) => {
					const path = new URL(input).pathname
					paths.push(path)
					return path === '/health' ? Promise.resolve(new Response(health + ' '.repeat(4096 - health.length))) : inner.containerFetch(input, init)
				},
			},
			new FakeR2(),
			job,
		)
		expect(result.status.state).toBe('succeeded')
		expect(paths).toEqual(['/health', '/run', '/logs', '/status'])
	})

	test('a lost response after POST remains ambiguous rather than writing a failed outcome', async () => {
		const bucket = new FakeR2()
		const error = new Error('POST response lost')
		const inner = makeContainer(terminalStatus, [], { count: 0 })
		const paths: string[] = []
		await expect(relayRun(
			{
				containerFetch: (input, init) => {
					paths.push(new URL(input).pathname)
					if (init?.method === 'POST') throw error
					return inner.containerFetch(input, init)
				},
			},
			bucket,
			job,
		)).rejects.toBe(error)
		expect(paths).toEqual(['/health', '/run'])
		expect(bucket.objects.size).toBe(0)
	})

	test('the job it posts to the container carries no runner key', async () => {
		const bodies: string[] = []
		const inner = makeContainer(terminalStatus, sampleLines, { count: 0 })
		const container: ContainerLike = {
			containerFetch: (input, init) => {
				if (init?.method === 'POST' && typeof init.body === 'string') {
					bodies.push(init.body)
				}
				return inner.containerFetch(input, init)
			},
		}

		await relayRun(container, new FakeR2(), job, { flushIntervalMs: 0 })

		// Everything in the container runs the checkout's own code as root, so the secret that
		// authenticates control to the runner Worker must not be in the process it can read.
		expect(bodies).toHaveLength(1)
		const posted: Record<string, unknown> = JSON.parse(bodies[0] ?? '{}')
		expect(Object.hasOwn(posted, 'runnerKey')).toBe(false)
		expect(posted.runId).toBe('run-relay-1')
		expect(posted.credentials).toEqual({ CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' })
	})

	test('relays the streamed log to R2 and persists terminal status', async () => {
		const bucket = new FakeR2()
		const heartbeats = { count: 0 }
		const container = makeContainer(terminalStatus, sampleLines, heartbeats)

		const result = await relayRun(container, bucket, job, { flushIntervalMs: 0 })

		expect(result.status).toEqual(terminalStatus)
		expect(result.lineCount).toBe(3)

		// Logs landed in R2 under the run-keyed object, as NDJSON.
		const stored = bucket.objects.get(logsKey('run-relay-1'))
		expect(stored).toBeDefined()
		const storedLines = (stored ?? '').split('\n').filter((l) => l.length > 0).map((l) => {
			const line: RunLogLine = JSON.parse(l)
			return line
		})
		expect(storedLines).toHaveLength(3)
		expect(storedLines[2]?.text).toBe('sample → stage: succeeded')

		// Terminal status persisted too.
		const statusObj: RunnerStatus = JSON.parse(bucket.objects.get(statusKey('run-relay-1')) ?? '{}')
		expect(statusObj.state).toBe('succeeded')
		expect(statusObj.exitCode).toBe(0)
	})

	test('heartbeats the container while relaying (long-job keepalive)', async () => {
		const bucket = new FakeR2()
		const heartbeats = { count: 0 }
		const container = makeContainer(terminalStatus, sampleLines, heartbeats)
		await relayRun(container, bucket, job, { flushIntervalMs: 0 })
		// At least one heartbeat per relayed line.
		expect(heartbeats.count).toBeGreaterThanOrEqual(sampleLines.length)
	})

	test('a failed run is relayed faithfully (state failed, exit code preserved)', async () => {
		const bucket = new FakeR2()
		const failed: RunnerStatus = { runId: 'run-relay-1', state: 'failed', exitCode: 1, startedAt: 1, finishedAt: 9 }
		const container = makeContainer(failed, sampleLines, { count: 0 })
		const result = await relayRun(container, bucket, job, { flushIntervalMs: 0 })
		expect(result.status.state).toBe('failed')
		expect(result.status.exitCode).toBe(1)
		expect(JSON.parse(bucket.objects.get(statusKey('run-relay-1')) ?? '{}').state).toBe('failed')
	})

	test('throws when the container rejects /run', async () => {
		const bucket = new FakeR2()
		const inner = makeContainer(terminalStatus, [], { count: 0 })
		const container: ContainerLike = {
			containerFetch: (input, init) =>
				init?.method === 'POST' ? Promise.resolve(new Response('busy', { status: 409 })) : inner.containerFetch(input, init),
		}
		await expect(relayRun(container, bucket, job)).rejects.toThrow('runner rejected /run')
	})

	test('joins a delayed upload, coalesces overlapping requests, and awaits the complete final snapshot before status', async () => {
		const started = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
		const uploads = Array.from({ length: 3 }, () => Promise.withResolvers<void>())
		const snapshots: string[] = []
		const bucket = new FakeR2()
		const allLinesSeen = Promise.withResolvers<void>()
		let lineCount = 0
		const { container, logs } = await makeStreamingContainer(() => {
			if (++lineCount === sampleLines.length) allLinesSeen.resolve()
		})
		const delayedBucket: R2Like = {
			put: async (key, value) => {
				if (key === logsKey(job.runId)) {
					const index = snapshots.length
					snapshots.push(value)
					started[index]?.resolve()
					await uploads[index]?.promise
				}
				await bucket.put(key, value)
			},
		}
		const relay = relayRun(container, delayedBucket, job, { flushIntervalMs: 0 })
		try {
			logs.enqueue(new TextEncoder().encode(ndjson(sampleLines.slice(0, 1))))
			await started[0]?.promise
			logs.enqueue(new TextEncoder().encode(ndjson(sampleLines.slice(1))))
			logs.close()
			await allLinesSeen.promise
			await Bun.sleep(0)

			expect(snapshots).toEqual([JSON.stringify(sampleLines[0])])
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
			uploads[0]?.resolve()
			await started[1]?.promise
			expect(snapshots).toHaveLength(2)
			expect(snapshots[1]).toBe(ndjson(sampleLines).trimEnd())
			uploads[1]?.resolve()
			await started[2]?.promise
			expect(snapshots).toHaveLength(3)
			expect(snapshots[2]).toBe(ndjson(sampleLines).trimEnd())
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
			uploads[2]?.resolve()
			const result = await relay
			expect(result.lineCount).toBe(sampleLines.length)
			expect(bucket.objects.get(logsKey(job.runId))).toBe(ndjson(sampleLines).trimEnd())
			expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(terminalStatus))
		} finally {
			for (const upload of uploads) upload.resolve()
			await relay
		}
	})

	test('awaits an empty final log object before publishing status', async () => {
		const started = Promise.withResolvers<void>()
		const upload = Promise.withResolvers<void>()
		const bucket = new FakeR2()
		const snapshots: string[] = []
		const delayedBucket: R2Like = {
			put: async (key, value) => {
				if (key === logsKey(job.runId)) {
					snapshots.push(value)
					started.resolve()
					await upload.promise
				}
				await bucket.put(key, value)
			},
		}
		const relay = relayRun(makeContainer(terminalStatus, [], { count: 0 }), delayedBucket, job)
		try {
			await started.promise
			expect(snapshots).toEqual([''])
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
			upload.resolve()
			expect((await relay).lineCount).toBe(0)
			expect(bucket.objects.get(logsKey(job.runId))).toBe('')
			expect(bucket.objects.get(statusKey(job.runId))).toBe(JSON.stringify(terminalStatus))
		} finally {
			upload.resolve()
			await relay
		}
	})

	test.each([false, true])('observes an intermediate rejection and propagates it after the final attempt (final fails: %s)', async (finalFails) => {
		const firstStarted = Promise.withResolvers<void>()
		const firstUpload = Promise.withResolvers<void>()
		const firstError = new Error('intermediate upload failed')
		const bucket = new FakeR2()
		const snapshots: string[] = []
		const unhandled: unknown[] = []
		const onUnhandled = (error: unknown): void => {
			unhandled.push(error)
		}
		const { container, logs } = await makeStreamingContainer()
		const failingBucket: R2Like = {
			put: async (key, value) => {
				if (key === logsKey(job.runId)) {
					snapshots.push(value)
					if (snapshots.length === 1) {
						firstStarted.resolve()
						await firstUpload.promise
					} else if (finalFails) {
						throw new Error('final upload failed')
					}
				}
				await bucket.put(key, value)
			},
		}
		process.on('unhandledRejection', onUnhandled)
		const outcome = relayRun(container, failingBucket, job, { flushIntervalMs: 100, now: () => 100 }).then(
			() => undefined,
			(error: unknown) => error,
		)
		try {
			logs.enqueue(new TextEncoder().encode(ndjson(sampleLines.slice(0, 1))))
			await firstStarted.promise
			firstUpload.reject(firstError)
			await Bun.sleep(0)
			expect(unhandled).toEqual([])
			logs.enqueue(new TextEncoder().encode(ndjson(sampleLines.slice(1))))
			logs.close()
			expect(await outcome).toBe(firstError)
			expect(snapshots).toEqual([JSON.stringify(sampleLines[0]), ndjson(sampleLines).trimEnd()])
			expect(bucket.objects.get(logsKey(job.runId))).toBe(finalFails ? undefined : ndjson(sampleLines).trimEnd())
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', onUnhandled)
		}
	})

	test.each([false, true])('propagates a final upload failure without publishing status (empty: %s)', async (empty) => {
		const error = new Error('final upload failed')
		const bucket = new FakeR2()
		const snapshots: string[] = []
		const failingBucket: R2Like = {
			put: async (key, value) => {
				if (key === logsKey(job.runId)) {
					snapshots.push(value)
					throw error
				}
				await bucket.put(key, value)
			},
		}
		const lines = empty ? [] : sampleLines
		const outcome = relayRun(makeContainer(terminalStatus, lines, { count: 0 }), failingBucket, job, { now: () => 0 }).then(
			() => undefined,
			(error: unknown) => error,
		)
		expect(await outcome).toBe(error)
		expect(snapshots).toEqual([empty ? '' : ndjson(sampleLines).trimEnd()])
		expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
	})

	test('settles an owned upload before propagating a stream error', async () => {
		const started = Promise.withResolvers<void>()
		const upload = Promise.withResolvers<void>()
		const error = new Error('log stream disconnected')
		const bucket = new FakeR2()
		const { container, logs } = await makeStreamingContainer()
		let settled = false
		const delayedBucket: R2Like = {
			put: async (key, value) => {
				started.resolve()
				await upload.promise
				await bucket.put(key, value)
			},
		}
		const outcome = relayRun(container, delayedBucket, job, { flushIntervalMs: 0 }).then(
			() => {
				settled = true
			},
			(error: unknown) => {
				settled = true
				return error
			},
		)
		try {
			logs.enqueue(new TextEncoder().encode(ndjson(sampleLines.slice(0, 1))))
			await started.promise
			logs.error(error)
			await Bun.sleep(0)
			expect(settled).toBe(false)
			upload.resolve()
			expect(await outcome).toBe(error)
			expect(bucket.objects.get(logsKey(job.runId))).toBe(JSON.stringify(sampleLines[0]))
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
		} finally {
			upload.resolve()
			await outcome
		}
	})
})
