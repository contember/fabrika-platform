import { CLOUDFLARE_SOURCE_PROTOCOL, type CloudflareRunnerJob } from '@fabrika/provider-cloudflare/runner'
import type { RunnerStatus } from '@fabrika/runner-contract'
import { describe, expect, mock, spyOn, test } from 'bun:test'
import { logsKey, statusKey } from '../relay'
import type { Env } from '../worker-env'

// The RPC boundary itself: `startRun` / `cancelRun` must refuse a caller that does not present
// `FABRIKA_RUNNER_KEY` BEFORE any side effect, because a Cloudflare service binding is not a
// capability — any Worker on the account can bind `<env>-vozka-runner`. The fakes below make every
// side effect (addressing the container DO, touching R2) record itself and then throw,
// so "refused first" is proved by an EMPTY record, not by the absence of an assertion.

// `VozkaRunner` extends `WorkerEntrypoint`, and `RunnerContainer` extends `@cloudflare/containers`'
// `Container` (itself a `DurableObject`) — neither module specifier resolves under bun's test runtime.
// Stub both base classes with what the real ones do for our purposes: assign ctx/env.
mock.module('cloudflare:workers', () => ({
	WorkerEntrypoint: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
	DurableObject: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
}))

const { VozkaRunner } = await import('../worker')

const RUNNER_KEY = 'test-runner-key'
const RUN_ID = '0198c0de-0000-7000-8000-000000000001'

const job: CloudflareRunnerJob = {
	runId: RUN_ID,
	repoUrl: 'https://github.com/acme/app.git',
	ref: 'abcdef1234567890abcdef1234567890abcdef12',
	env: 'stage',
	runnerKey: RUNNER_KEY,
	credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 'tok' },
}

/** Re-read a fixture as a job (a JSON round-trip keeps an intentionally malformed one honest, with no `as`). */
function asJob(value: unknown): CloudflareRunnerJob {
	const box: { v: CloudflareRunnerJob } = JSON.parse(JSON.stringify({ v: value }))
	return box.v
}

/** Every side effect the Worker can reach records itself here and then aborts the call. */
const REACHED_CONTAINER = 'container reached'

function runnerNamespace(touched: string[]): Env['RUNNER'] {
	return {
		idFromName(name: string): never {
			touched.push(`idFromName:${name}`)
			throw new Error(REACHED_CONTAINER)
		},
		newUniqueId(): never {
			touched.push('newUniqueId')
			throw new Error(REACHED_CONTAINER)
		},
		idFromString(): never {
			touched.push('idFromString')
			throw new Error(REACHED_CONTAINER)
		},
		get(): never {
			touched.push('get')
			throw new Error(REACHED_CONTAINER)
		},
		getByName(): never {
			touched.push('getByName')
			throw new Error(REACHED_CONTAINER)
		},
		jurisdiction(): never {
			touched.push('jurisdiction')
			throw new Error(REACHED_CONTAINER)
		},
	}
}

function bucket(touched: string[]): Env['RUN_LOGS'] {
	const record = (label: string) => (): never => {
		touched.push(`r2:${label}`)
		throw new Error('unexpected R2 access')
	}
	return {
		head: record('head'),
		get: record('get'),
		put: record('put'),
		createMultipartUpload: record('createMultipartUpload'),
		resumeMultipartUpload: record('resumeMultipartUpload'),
		delete: record('delete'),
		list: record('list'),
	}
}

interface Harness {
	readonly worker: InstanceType<typeof VozkaRunner>
	readonly touched: string[]
}

function harness(runnerKey?: string): Harness {
	const touched: string[] = []
	const env: Env = {
		RUNNER: runnerNamespace(touched),
		RUN_LOGS: bucket(touched),
		ENVIRONMENT: 'stage',
		...(runnerKey === undefined ? {} : { FABRIKA_RUNNER_KEY: runnerKey }),
	}
	const worker: unknown = Reflect.construct(VozkaRunner, [{ waitUntil: () => {} }, env])
	if (!(worker instanceof VozkaRunner)) {
		throw new Error('failed to construct the mocked Worker entrypoint')
	}
	return { worker, touched }
}

describe('VozkaRunner.startRun', () => {
	test('a legacy mutable non-dry job fails before authentication or container effects', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.startRun({ ...job, ref: 'refs/heads/main' })).rejects.toThrow('runner: invalid job')
		expect(touched).toEqual([])
	})

	test('an unconfigured runner key denies every job, before the container or R2', async () => {
		const { worker, touched } = harness()
		await expect(worker.startRun(job)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
		expect(touched).toEqual([])
	})

	test('an empty configured key denies rather than matching an empty presented one', async () => {
		const { worker, touched } = harness('')
		await expect(worker.startRun(job)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
		await expect(worker.startRun({ ...job, runnerKey: '' })).rejects.toThrow('runner: invalid job')
		expect(touched).toEqual([])
	})

	test('a job presenting the wrong key is refused with a message that names nothing', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.startRun({ ...job, runnerKey: 'test-runner-keY' })).rejects.toThrow('runner: unauthorized')
		expect(touched).toEqual([])
	})

	test('a malformed job is refused before any side effect, even carrying the right key', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.startRun(asJob({ ...job, workerDir: 42 }))).rejects.toThrow('runner: invalid job')
		await expect(worker.startRun({ ...job, repoUrl: 'ext::sh -c id' })).rejects.toThrow('runner: invalid job')
		await expect(worker.startRun(asJob({ ...job, credentials: { CLOUDFLARE_ACCOUNT_ID: 'acc' } }))).rejects.toThrow('runner: invalid job')
		expect(touched).toEqual([])
	})

	test('a job with no key at all is unauthorized, not merely malformed', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		const { runnerKey: _unused, ...keyless } = job
		await expect(worker.startRun(asJob(keyless))).rejects.toThrow('runner: unauthorized')
		expect(touched).toEqual([])
	})

	test("the right key proceeds to the run's container", async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.startRun(job)).rejects.toThrow(REACHED_CONTAINER)
		expect(touched).toEqual([`idFromName:${RUN_ID}`])
	})
})

describe('VozkaRunner.sourceProtocol', () => {
	test('capability admission authenticates without container or storage effects', async () => {
		const unconfigured = harness()
		await expect(unconfigured.worker.sourceProtocol(RUNNER_KEY)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
		expect(unconfigured.touched).toEqual([])
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.sourceProtocol('guess')).rejects.toThrow('runner: unauthorized')
		expect(touched).toEqual([])
		expect(await worker.sourceProtocol(RUNNER_KEY)).toBe(CLOUDFLARE_SOURCE_PROTOCOL)
		expect(touched).toEqual([])
	})
})

function relayHarness(
	health: unknown,
	options: { postError?: Error; failedWrites?: readonly string[]; recovery?: RunnerStatus | null; persisted?: RunnerStatus } = {},
) {
	const failedWrites = options.failedWrites ?? []
	const objects = new Map<string, string>()
	if (options.persisted !== undefined) objects.set(statusKey(RUN_ID), JSON.stringify(options.persisted))
	const writeAttempts: string[] = []
	const paths: string[] = []
	const container = {
		startDeploy: async (runId: string, dryRun: boolean) => {
			expect(runId).toBe(RUN_ID)
			expect(dryRun).toBe(false)
		},
		deployFetch: async (input: string, init?: RequestInit) => {
			const path = new URL(input).pathname
			paths.push(path)
			expect(init?.signal).toBeUndefined()
			if (path === '/health') {
				expect(init).toEqual({ redirect: 'manual' })
				return new Response(JSON.stringify(health))
			}
			if (path === '/run' && options.postError !== undefined) throw options.postError
			throw new Error('unexpected container request')
		},
		heartbeat: async () => {},
		recoverDeploy: async (runId: string) => {
			paths.push(`recover:${runId}`)
			if (options.recovery === undefined) throw new Error('unexpected recovery')
			return options.recovery
		},
	}
	const env = {
		RUN_LOGS: {
			get: async (key: string) => {
				const value = objects.get(key)
				return value === undefined ? null : { text: async () => value }
			},
			put: async (key: string, value: string) => {
				writeAttempts.push(key)
				if (failedWrites.includes(key)) throw new Error('R2 error contains private-storage-token')
				objects.set(key, value)
			},
		},
		RUNNER: { idFromName: (runId: string) => runId, get: () => container },
		FABRIKA_RUNNER_KEY: RUNNER_KEY,
	}
	const worker: unknown = Reflect.construct(VozkaRunner, [{ waitUntil: () => {} }, env])
	if (!(worker instanceof VozkaRunner)) throw new Error('failed to construct Worker')
	return { worker, paths, objects, writeAttempts }
}

describe('VozkaRunner image admission settlement', () => {
	for (const failedWrites of [[logsKey(RUN_ID)], [statusKey(RUN_ID)], [logsKey(RUN_ID), statusKey(RUN_ID)]]) {
		test(`known pre-POST refusal still returns the failed status despite R2 failure: ${failedWrites.join(', ')}`, async () => {
			const { worker, paths, writeAttempts } = relayHarness({ status: 'ok', port: 8080 }, { failedWrites })
			const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
			try {
				const result = await worker.startRun(job)
				expect(result.status.state).toBe('failed')
				expect(paths).toEqual(['/health'])
				expect(writeAttempts).toEqual([logsKey(RUN_ID), statusKey(RUN_ID)])
				expect(diagnostic.mock.calls).toHaveLength(failedWrites.length)
				expect(JSON.stringify(result) + JSON.stringify(diagnostic.mock.calls)).not.toContain('private-storage-token')
			} finally {
				diagnostic.mockRestore()
			}
		})
	}

	test('an old image produces zero job POSTs and persists the failed status that recovery reads back', async () => {
		const { worker, paths, objects } = relayHarness({ status: 'ok', port: 8080 })
		const result = await worker.startRun(job)
		expect(result.status.state).toBe('failed')
		expect(paths).toEqual(['/health'])
		expect(objects.get(logsKey(RUN_ID))).toContain('source protocol is unavailable or not supported')
		expect(objects.get(statusKey(RUN_ID))).toBe(JSON.stringify(result.status))
		expect(await worker.recoverRun(RUN_ID, RUNNER_KEY)).toEqual(result.status)
		expect(paths).toEqual(['/health'])
	})

	test('ambiguous post-POST errors still throw and leave the accepted run in flight for recovery', async () => {
		const error = new Error('POST response lost')
		const { worker, paths, objects } = relayHarness({ status: 'ok', port: 8080, sourceProtocol: CLOUDFLARE_SOURCE_PROTOCOL }, {
			postError: error,
			recovery: null,
		})
		await expect(worker.startRun(job)).rejects.toBe(error)
		expect(paths).toEqual(['/health', '/run'])
		expect(objects.size).toBe(0)
		expect(await worker.recoverRun(RUN_ID, RUNNER_KEY)).toBeNull()
		expect(paths).toEqual(['/health', '/run', `recover:${RUN_ID}`])
	})
})

describe('VozkaRunner.cancelRun', () => {
	test('an unconfigured runner key denies the cancel, before the container or R2', async () => {
		const { worker, touched } = harness()
		await expect(worker.cancelRun(RUN_ID, RUNNER_KEY)).rejects.toThrow('FABRIKA_RUNNER_KEY is not configured')
		expect(touched).toEqual([])
	})

	test("a wrong key cannot destroy another run's container", async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.cancelRun(RUN_ID, 'guess')).rejects.toThrow('runner: unauthorized')
		expect(touched).toEqual([])
	})

	test('a run id that is not a uuid never addresses a container', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.cancelRun('../../etc', RUNNER_KEY)).rejects.toThrow('runner: invalid run id')
		expect(touched).toEqual([])
	})

	test("the right key proceeds to the run's container", async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.cancelRun(RUN_ID, RUNNER_KEY)).rejects.toThrow(REACHED_CONTAINER)
		expect(touched).toEqual([`idFromName:${RUN_ID}`])
	})
})

describe('VozkaRunner.recoverRun', () => {
	test('recovery authenticates and validates coordinates before reading storage or fencing the container', async () => {
		const { worker, touched } = harness(RUNNER_KEY)
		await expect(worker.recoverRun(RUN_ID, 'guess')).rejects.toThrow('runner: unauthorized')
		await expect(worker.recoverRun('../../etc', RUNNER_KEY)).rejects.toThrow('runner: invalid run id')
		expect(touched).toEqual([])
		await expect(worker.recoverRun(RUN_ID, RUNNER_KEY)).rejects.toThrow('unexpected R2 access')
		expect(touched).toEqual(['r2:get'])
	})

	test('a persisted terminal status is returned with its IAM reconcile, without touching the container', async () => {
		const persisted: RunnerStatus = {
			runId: RUN_ID,
			state: 'succeeded',
			exitCode: 0,
			iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' },
			startedAt: 1,
			finishedAt: 9,
		}
		const { worker, paths } = relayHarness({}, { persisted })
		expect(await worker.recoverRun(RUN_ID, RUNNER_KEY)).toEqual(persisted)
		expect(paths).toEqual([])
	})

	test("with no persisted status the run's Durable Object settles it", async () => {
		const settled: RunnerStatus = { runId: RUN_ID, state: 'failed', error: 'runner never dispatched the run', startedAt: 1, finishedAt: 1 }
		const { worker, paths } = relayHarness({}, { recovery: settled })
		expect(await worker.recoverRun(RUN_ID, RUNNER_KEY)).toEqual(settled)
		expect(paths).toEqual([`recover:${RUN_ID}`])
	})
})
