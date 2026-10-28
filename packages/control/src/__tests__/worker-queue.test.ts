import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import type { WorkerBindings } from '../platform-cf'
import { createHarness } from './helpers/harness'

// `Vozka` extends `WorkerEntrypoint` from 'cloudflare:workers', which bun's test runtime cannot resolve. bun's module
// mocks are process-wide, so the stub offers every export another suite's stub does.
mock.module('cloudflare:workers', () => ({
	WorkerEntrypoint: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
	DurableObject: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
}))

const { Vozka } = await import('../index')

function workerBindings(harness: ReturnType<typeof createHarness>): WorkerBindings {
	const unexpected = (): never => {
		throw new Error('unexpected binding access')
	}
	return {
		ENVIRONMENT: 'stage',
		DB: harness.d1,
		ASSETS: { fetch: unexpected, connect: unexpected },
		RUN_LOGS: {
			head: unexpected,
			get: unexpected,
			put: unexpected,
			createMultipartUpload: unexpected,
			resumeMultipartUpload: unexpected,
			delete: unexpected,
			list: unexpected,
		},
		DEPLOY_QUEUE: { send: unexpected, sendBatch: unexpected, metrics: unexpected },
		FABRIKA_RUNNER_KEY: 'test-runner-key',
		CLOUDFLARE_ACCOUNT_ID: 'account',
		CLOUDFLARE_API_TOKEN: 'token',
	}
}

interface Delivery {
	readonly message: Message<unknown>
	readonly acked: () => number
	readonly retried: () => number
}

function delivery(body: unknown): Delivery {
	let acks = 0
	let retries = 0
	return {
		message: {
			id: 'message-1',
			timestamp: new Date(0),
			attempts: 1,
			body,
			ack: () => {
				acks += 1
			},
			retry: () => {
				retries += 1
			},
		},
		acked: () => acks,
		retried: () => retries,
	}
}

function batchOf(deliveries: readonly Delivery[]): MessageBatch<unknown> {
	return {
		queue: 'stage-vozka-deploy',
		messages: deliveries.map((one) => one.message),
		metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
		ackAll: () => {},
		retryAll: () => {},
	}
}

describe("the Worker's control queue consumer", () => {
	let harness: ReturnType<typeof createHarness>
	let errors: ReturnType<typeof spyOn<Console, 'error'>>

	beforeEach(() => {
		harness = createHarness()
		errors = spyOn(console, 'error').mockImplementation(() => {})
	})

	afterEach(() => {
		errors.mockRestore()
	})

	// The stub's constructor takes any context; the handler under test uses only `waitUntil`.
	const worker = (): InstanceType<typeof Vozka> => {
		const entrypoint: unknown = Reflect.construct(Vozka, [{ waitUntil: () => {} }, workerBindings(harness)])
		if (!(entrypoint instanceof Vozka)) throw new Error('failed to construct the mocked Worker entrypoint')
		return entrypoint
	}

	test.each([
		['a non-object', 'run-1'],
		['a deploy job without a run id', { dryRun: true }],
		['a namespace job without a namespace id', { kind: 'namespace', mutation: 'reconcile' }],
		['an unknown kind', { kind: 'sweep', runId: 'run-1' }],
	])('acks %s without running it, and retries nothing', async (_name, body) => {
		const one = delivery(body)
		await worker().queue(batchOf([one]))
		expect(one.acked()).toBe(1)
		expect(one.retried()).toBe(0)
		expect(errors.mock.calls.some(([line]) => line === 'control job: undecodable payload, dropped')).toBe(true)
	})

	test('hands a decodable deploy job to the lifecycle', async () => {
		const infos = spyOn(console, 'info').mockImplementation(() => {})
		try {
			const one = delivery({ runId: 'run-that-does-not-exist' })
			await worker().queue(batchOf([one]))
			expect(infos.mock.calls).toEqual([['deploy run run-that-does-not-exist: skipped']])
			expect(one.acked()).toBe(1)
			expect(one.retried()).toBe(0)
		} finally {
			infos.mockRestore()
		}
	})
})
