import type { RunLogLine } from '@fabrika/control-contract'
import type { CloudflareRunnerJob, RunnerStatus } from '@fabrika/provider-cloudflare/runner'
import { describe, expect, test } from 'bun:test'
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
	approvedAccess: { kind: 'artifact' },
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
	for (
		const raw of [
			'{private-token',
			'{"state":"succeeded"}',
			JSON.stringify({ ...terminalStatus, runId: 'another-run' }),
			JSON.stringify({ ...terminalStatus, exitCode: '0' }),
		]
	) {
		test(`refuses malformed or foreign status without persisting it: ${raw}`, async () => {
			const inner = makeContainer(terminalStatus, [], { count: 0 })
			const bucket = new FakeR2()
			await expect(relayRun(
				{
					containerFetch: (input, init) =>
						new URL(input).pathname === '/status'
							? Promise.resolve(new Response(raw))
							: inner.containerFetch(input, init),
				},
				bucket,
				job,
			)).rejects.toThrow('runner returned malformed status')
			expect(bucket.objects.has(statusKey(job.runId))).toBe(false)
		})
	}
	for (const raw of ['{"ts":1,"stream":"private-token","text":"line"}\n', '{private-token', '{"ts":1,"stream":"stdout"}']) {
		test('malformed NDJSON has a secret-safe diagnostic, including the final unterminated line', async () => {
			const inner = makeContainer(terminalStatus, [], { count: 0 })
			const bucket = new FakeR2()
			await expect(relayRun(
				{
					containerFetch: (input, init) =>
						new URL(input).pathname === '/logs'
							? Promise.resolve(new Response(raw))
							: inner.containerFetch(input, init),
				},
				bucket,
				job,
			)).rejects.toThrow('runner returned malformed log line')
			expect([...bucket.objects.values()].join('\n')).not.toContain('private-token')
		})
	}
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
		expect(paths).toEqual(['/run'])
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

	test('the persisted status is dry exactly when the job is, whatever the container claims', async () => {
		const dry = new FakeR2()
		const dryResult = await relayRun(makeContainer(terminalStatus, sampleLines, { count: 0 }), dry, { ...job, dryRun: true }, { flushIntervalMs: 0 })
		expect(dryResult.status).toEqual({ ...terminalStatus, dryRun: true })
		expect(JSON.parse(dry.objects.get(statusKey('run-relay-1')) ?? '{}')).toEqual({ ...terminalStatus, dryRun: true })

		const live = new FakeR2()
		const claimedDry = makeContainer({ ...terminalStatus, dryRun: true }, sampleLines, { count: 0 })
		expect((await relayRun(claimedDry, live, job, { flushIntervalMs: 0 })).status).toEqual(terminalStatus)
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
