import type { RunnerStatus } from '@fabrika/runner-contract'
import { describe, expect, spyOn, test } from 'bun:test'
import { statusKey } from '../relay'
import {
	backstopTick,
	DEADLINE_PASSED,
	NEVER_DISPATCHED,
	PERSISTED_STATUS_MALFORMED,
	type R2Store,
	readTerminalStatus,
	recoverDispatched,
	RUN_DEADLINE_MS,
	type RunSettlementPorts,
	settleRun,
} from '../run-outcome'

const RUN_ID = 'r'
const NOW = 5_000

const status = (state: RunnerStatus['state'], extra: Partial<RunnerStatus> = {}): RunnerStatus => ({ runId: RUN_ID, state, startedAt: 1, ...extra })

const store = (objects: Map<string, string>, failPut = false): R2Store => ({
	get: async (key) => {
		const value = objects.get(key)
		return value === undefined ? null : { text: async () => value }
	},
	put: async (key, value) => {
		if (failPut) throw new Error('R2 unavailable')
		objects.set(key, value)
	},
})

interface Fixture {
	readonly ports: RunSettlementPorts
	readonly objects: Map<string, string>
	readonly flushed: string[]
}

const fixture = (observed: RunnerStatus | null, options: { dryRun?: boolean; failPut?: boolean; persisted?: string } = {}): Fixture => {
	const objects = new Map<string, string>()
	if (options.persisted !== undefined) objects.set(statusKey(RUN_ID), options.persisted)
	const flushed: string[] = []
	return {
		objects,
		flushed,
		ports: {
			runId: RUN_ID,
			dryRun: options.dryRun === true,
			bucket: store(objects, options.failPut === true),
			now: () => NOW,
			containerStatus: async () => observed,
			flushLogs: async () => {
				flushed.push('logs')
			},
		},
	}
}

const persistedStatus = (objects: Map<string, string>): unknown => JSON.parse(objects.get(statusKey(RUN_ID)) ?? 'null')

describe('readTerminalStatus', () => {
	test('returns the persisted terminal status with its IAM reconcile, and null when none or not terminal', async () => {
		const objects = new Map<string, string>()
		expect(await readTerminalStatus(store(objects), RUN_ID, NOW)).toBeNull()
		const terminal = status('succeeded', { exitCode: 0, iamReconcile: { app: 'api', schemaJson: '{"actions":[]}' } })
		objects.set(statusKey(RUN_ID), JSON.stringify(terminal))
		expect(await readTerminalStatus(store(objects), RUN_ID, NOW)).toEqual(terminal)
		objects.set(statusKey(RUN_ID), JSON.stringify(status('deploying')))
		expect(await readTerminalStatus(store(objects), RUN_ID, NOW)).toBeNull()
	})

	test('a malformed or foreign persisted status settles the run as failed instead of throwing forever', async () => {
		const failed: RunnerStatus = { runId: RUN_ID, state: 'failed', error: PERSISTED_STATUS_MALFORMED, startedAt: NOW, finishedAt: NOW }
		for (const persisted of ['{"runId":', JSON.stringify({ ...status('failed'), runId: 'other' }), JSON.stringify({ state: 'succeeded' })]) {
			expect(await readTerminalStatus(store(new Map([[statusKey(RUN_ID), persisted]])), RUN_ID, NOW)).toEqual(failed)
		}
	})
})

describe('settleRun', () => {
	test('an already persisted status is returned without asking the container', async () => {
		const { ports, objects, flushed } = fixture(status('deploying'), { persisted: JSON.stringify(status('succeeded', { exitCode: 0 })) })
		expect(await settleRun(ports, NOW + 1)).toEqual(status('succeeded', { exitCode: 0 }))
		expect(flushed).toEqual([])
		expect(persistedStatus(objects)).toEqual(status('succeeded', { exitCode: 0 }))
	})

	test("a terminal container status is persisted with the DO's dry-run flag, logs first", async () => {
		const { ports, objects, flushed } = fixture(status('succeeded', { exitCode: 0, dryRun: false }), { dryRun: true })
		const settled = await settleRun(ports, NOW + 1)
		expect(settled).toEqual(status('succeeded', { exitCode: 0, dryRun: true }))
		expect(persistedStatus(objects)).toEqual(settled)
		expect(flushed).toEqual(['logs'])

		const claimedDry = fixture(status('failed', { exitCode: 1, dryRun: true }))
		expect(await settleRun(claimedDry.ports, NOW + 1)).toEqual(status('failed', { exitCode: 1 }))
	})

	test('in flight or unreachable before the deadline stays unsettled and persists nothing', async () => {
		for (const observed of [status('deploying'), null]) {
			const { ports, objects } = fixture(observed)
			expect(await settleRun(ports, NOW)).toBeNull()
			expect(objects.size).toBe(0)
		}
	})

	test('past the deadline (in flight OR unreachable) persists failed rather than dangle forever', async () => {
		const inFlight = fixture(status('deploying'))
		expect(await settleRun(inFlight.ports, NOW - 1)).toEqual({ runId: RUN_ID, state: 'failed', error: DEADLINE_PASSED, startedAt: 1, finishedAt: NOW })
		expect(inFlight.flushed).toEqual(['logs'])
		const unreachable = fixture(null)
		expect(await settleRun(unreachable.ports, NOW - 1)).toEqual({
			runId: RUN_ID,
			state: 'failed',
			error: DEADLINE_PASSED,
			startedAt: NOW,
			finishedAt: NOW,
		})
		expect(persistedStatus(unreachable.objects)).toMatchObject({ state: 'failed', error: DEADLINE_PASSED })
		expect(unreachable.flushed).toEqual([])
	})

	test('a storage failure throws so the caller retries', async () => {
		const { ports } = fixture(status('succeeded', { exitCode: 0 }), { failPut: true })
		await expect(settleRun(ports, NOW + 1)).rejects.toThrow('R2 unavailable')
	})
})

describe('recoverDispatched', () => {
	test('a never-dispatched run is persisted failed, unless a status is already persisted', async () => {
		const { ports, objects } = fixture(null, { dryRun: true })
		const recovered = await recoverDispatched(ports, null)
		expect(recovered).toEqual({ runId: RUN_ID, state: 'failed', error: NEVER_DISPATCHED, startedAt: NOW, finishedAt: NOW, dryRun: true })
		expect(persistedStatus(objects)).toEqual(recovered)

		const refused = fixture(null, { persisted: JSON.stringify(status('failed', { error: 'source protocol refused' })) })
		expect(await recoverDispatched(refused.ports, null)).toEqual(status('failed', { error: 'source protocol refused' }))
	})

	test('a dispatched run is settled from the container itself, with the deadline counted from dispatch', async () => {
		const done = fixture(status('succeeded', { exitCode: 0 }))
		expect(await recoverDispatched(done.ports, NOW)).toEqual(status('succeeded', { exitCode: 0 }))
		expect(persistedStatus(done.objects)).toEqual(status('succeeded', { exitCode: 0 }))

		const running = fixture(status('deploying'))
		expect(await recoverDispatched(running.ports, NOW - RUN_DEADLINE_MS)).toBeNull()
		const expired = fixture(null)
		expect(await recoverDispatched(expired.ports, NOW - RUN_DEADLINE_MS - 1)).toMatchObject({ state: 'failed', error: DEADLINE_PASSED })
	})
})

describe('backstopTick', () => {
	test('a settled run stops the backstop; an unsettled one reschedules', async () => {
		const ticks: string[] = []
		await backstopTick(async () => status('succeeded'), async () => {
			ticks.push('reschedule')
		})
		expect(ticks).toEqual([])
		await backstopTick(async () => null, async () => {
			ticks.push('reschedule')
		})
		expect(ticks).toEqual(['reschedule'])
	})

	test('a failed settlement reschedules instead of being dropped, and logs no error detail', async () => {
		const ticks: string[] = []
		const diagnostic = spyOn(console, 'error').mockImplementation(() => {})
		try {
			await backstopTick(async () => {
				throw new Error('R2 error contains private-storage-token')
			}, async () => {
				ticks.push('reschedule')
			})
			expect(ticks).toEqual(['reschedule'])
			expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-storage-token')
		} finally {
			diagnostic.mockRestore()
		}
	})
})
