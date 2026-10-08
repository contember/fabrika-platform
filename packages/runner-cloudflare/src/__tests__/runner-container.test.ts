import { describe, expect, mock, spyOn, test } from 'bun:test'
import type { Env } from '../worker-env'

// Backlog 89. Any Worker on the account can bind `RunnerContainer` and start an instance under a name of
// its own. Every method that names a run persists that run's status (and IAM reconcile) to R2, so each
// refuses a run whose keyed name is not this instance's — before the container, DO storage or R2.

// The same module shape worker.test.ts mocks: bun's mocks are process-wide, whichever file runs first.
mock.module('cloudflare:workers', () => ({
	WorkerEntrypoint: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
	DurableObject: class<E> {
		constructor(public readonly ctx: unknown, public readonly env: E) {}
	},
}))

const { RunnerContainer } = await import('../RunnerContainer')
const { runnerInstanceName } = await import('../runner-key')

const RUNNER_KEY = 'test-runner-key'
const RUN_ID = '0198c0de-0000-7000-8000-000000000001'
const FOREIGN = 'runner: this instance does not belong to that run'

const id = (name: string): DurableObjectId => ({ name, toString: () => name, equals: (other) => other.name === name })

/** An instance named `selfName` that records every touch of its container, storage and R2 after construction. */
function instance(selfName: string, touched: string[]) {
	let constructed = false
	const record = (label: string): void => {
		if (constructed) touched.push(label)
	}
	const ctx = {
		id: id(selfName),
		container: {
			get running() {
				record('container.running')
				return false
			},
			getTcpPort: () => {
				record('container.getTcpPort')
				throw new Error('container reached')
			},
		},
		storage: {
			sql: {
				exec: (query: string) => {
					record(`sql:${query.trim().split(/\s+/)[0] ?? ''}`)
					return []
				},
			},
			get: () => {
				record('storage.get')
				return Promise.resolve(undefined)
			},
			put: () => {
				record('storage.put')
				return Promise.resolve()
			},
			setAlarm: () => Promise.resolve(),
			getAlarm: () => Promise.resolve(null),
			deleteAlarm: () => Promise.resolve(),
			sync: () => Promise.resolve(),
		},
		blockConcurrencyWhile: () => Promise.resolve(),
	}
	const refuse = (label: string) => (): never => {
		touched.push(label)
		throw new Error(`unexpected ${label}`)
	}
	const env: Env = {
		RUNNER: {
			idFromName: (name: string) => id(name),
			newUniqueId: refuse('newUniqueId'),
			idFromString: refuse('idFromString'),
			get: refuse('get'),
			getByName: refuse('getByName'),
			jurisdiction: refuse('jurisdiction'),
		},
		RUN_LOGS: {
			head: refuse('r2'),
			get: refuse('r2'),
			put: refuse('r2'),
			createMultipartUpload: refuse('r2'),
			resumeMultipartUpload: refuse('r2'),
			delete: refuse('r2'),
			list: refuse('r2'),
		},
		ENVIRONMENT: 'stage',
		FABRIKA_RUNNER_KEY: RUNNER_KEY,
	}
	const created: unknown = Reflect.construct(RunnerContainer, [ctx, env])
	if (!(created instanceof RunnerContainer)) throw new Error('failed to construct the container DO')
	constructed = true
	return created
}

describe('RunnerContainer refuses a run that is not its own', () => {
	test("an instance another Worker named cannot start, recover or back-stop a real run's id", async () => {
		for (const selfName of [RUN_ID, 'attacker-chosen', await runnerInstanceName('another-key', RUN_ID)]) {
			const touched: string[] = []
			const container = instance(selfName, touched)

			await expect(container.startDeploy(RUN_ID, false)).rejects.toThrow(FOREIGN)
			await expect(container.recoverDeploy(RUN_ID)).rejects.toThrow(FOREIGN)
			await expect(container.armBackstop(RUN_ID)).rejects.toThrow(FOREIGN)
			await expect(container.backstopCheck({ runId: RUN_ID, deadline: 0 })).rejects.toThrow(FOREIGN)
			expect({ selfName, touched }).toEqual({ selfName, touched: [] })
		}
	})

	test("the run's own keyed instance proceeds to the run's status in R2", async () => {
		const touched: string[] = []
		const container = instance(await runnerInstanceName(RUNNER_KEY, RUN_ID), touched)

		// Past the check the backstop reads the persisted status; the failed read reschedules the tick.
		const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
		try {
			await container.backstopCheck({ runId: RUN_ID, deadline: Date.now() + 60_000 })
		} finally {
			diagnostic.mockRestore()
		}
		expect(touched).toContain('r2')
	})
})
