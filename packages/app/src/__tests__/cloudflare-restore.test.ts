// The original object's point-in-time restore (ADR-0070 §9 step 6): `prepare` writes the sentinel and answers the
// bookmarks, `arm` arms the restore and then resets the object, and `verify` tells a restored object from one that was
// not by the sentinel. Storage is bun:sqlite with an in-memory KV, and the recovery a double that records every call:
// no local runtime restores, so the reset is simulated by putting the KV back to its state at the target.

import {
	ENDPOINT_HEADER,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_OPS_KEY_DIGESTS,
	formatOpsKeyDigests,
	OPS_DATA_REFUSED_STATUS,
	OPS_STALE_STATUS,
	OPS_STATE_KEY,
	opsKeyDigest,
	type OpsPublishedState,
	type OpsRestoreRequest,
	parseOpsDataRefusal,
	parseOpsRestoreArmAck,
	parseOpsRestorePrepareAck,
	parseOpsRestoreVerifyAck,
	parseOpsStaleRefusal,
	PROXY_SECRET_HEADER,
} from '@fabrika/auth-core'
import { Database as BunDatabase } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { bunSqliteStorage } from '../../../db/src/sqlite-bun'
import { type ApplicationState, FabrikaApplication } from '../cloudflare'
import { MaintenanceBarrier, type MaintenanceStore } from '../cloudflare/maintenance'
import { CLOUDFLARE_FILES_BINDING } from '../cloudflare/names'
import { OPS_ENDPOINT, type OpsRecovery, type OpsTarget } from '../cloudflare/ops'
import { serveRestore } from '../cloudflare/restore'

/** A step on an object ordinary traffic does not reach: the clone a side restore names. */
const restoreStep = (target: OpsTarget, barrier: MaintenanceBarrier, step: OpsRestoreRequest) => serveRestore(target, barrier, step, false)
import { ORIGIN, PROXY_SECRET } from './fixtures/implement/harness'

const OBJECT = 'application'
const SENTINEL = '0192f0c4-7a1e-7c3b-9d2a-5e6f7a8b9c0d'
const EARLIER_SENTINEL = '0192f0c4-0000-7c3b-9d2a-5e6f7a8b9c0d'
const GENERATION = 7
/** Inside the recovery window. */
const AT = '2026-10-20T08:00:00.000Z'
/** Before the window: thirty days back from the test's clock is long past this. */
const OUTSIDE_WINDOW = '2020-01-01T00:00:00.000Z'
const WINDOW_START = Date.parse('2026-01-01T00:00:00.000Z')

type Call =
	| { readonly kind: 'getCurrentBookmark' }
	| { readonly kind: 'getBookmarkForTime'; readonly time: number }
	| { readonly kind: 'onNextSessionRestoreBookmark'; readonly bookmark: string }
	| { readonly kind: 'abort'; readonly reason: string }
	| { readonly kind: 'kv.put'; readonly key: string; readonly value: unknown }

interface Harness {
	readonly target: OpsTarget
	readonly calls: Call[]
	/** The object's KV storage, which point-in-time recovery rewinds with its SQLite. */
	readonly kv: Map<string, unknown>
}

interface HarnessOptions {
	readonly recovery?: boolean
	/** A bookmark `onNextSessionRestoreBookmark` refuses. */
	readonly refusedTarget?: string
}

function harness(options: HarnessOptions = {}): Harness {
	const calls: Call[] = []
	const kv = new Map<string, unknown>()
	let writes = 0
	const sqlite = bunSqliteStorage(new BunDatabase(':memory:'))
	const storage = {
		...sqlite,
		get: (key: string) => Promise.resolve(kv.get(key)),
		put: (key: string, value: unknown) => {
			calls.push({ kind: 'kv.put', key, value })
			kv.set(key, value)
			writes++
			return Promise.resolve()
		},
	}
	const recovery: OpsRecovery = {
		getCurrentBookmark: () => {
			calls.push({ kind: 'getCurrentBookmark' })
			return Promise.resolve(`current-${writes}`)
		},
		getBookmarkForTime: (time) => {
			calls.push({ kind: 'getBookmarkForTime', time })
			return time < WINDOW_START ? Promise.reject(new Error('the time is outside the recovery window')) : Promise.resolve(`at-${time}`)
		},
		onNextSessionRestoreBookmark: (bookmark) => {
			calls.push({ kind: 'onNextSessionRestoreBookmark', bookmark })
			return bookmark === options.refusedTarget ? Promise.reject(new Error('not a bookmark')) : Promise.resolve(`undo-${writes}`)
		},
		abort: (reason) => {
			calls.push({ kind: 'abort', reason })
		},
	}
	const target: OpsTarget = {
		storage,
		bucket: null,
		recovery: options.recovery === false ? null : recovery,
		migrations: [],
		contractDigest: null,
		bootFailure: () => Promise.resolve(null),
		maintenance: () => Promise.reject(new Error('not called')),
		migrate: () => Promise.reject(new Error('not called')),
	}
	return { target, calls, kv }
}

/** An in-memory bucket for the barrier's state; `failing` makes every put throw, so a transition stays pending. */
function memoryStore(failing = false): MaintenanceStore {
	let held: { state: OpsPublishedState; version: string } | null = null
	let versions = 0
	return {
		read: () => Promise.resolve(held),
		put(state, version) {
			if (failing) {
				return Promise.reject(new Error('R2 is down'))
			}
			if ((held?.version ?? null) !== version) {
				return Promise.resolve(null)
			}
			held = { state, version: `v${++versions}` }
			return Promise.resolve(held.version)
		},
	}
}

async function barrierIn(mode: OpsPublishedState['mode'], generation = GENERATION): Promise<MaintenanceBarrier> {
	const barrier = await MaintenanceBarrier.load(memoryStore(), { drainBoundMs: 10 })
	const result = await barrier.transition({ generation, mode })
	expect(result.kind).toBe('acknowledged')
	return barrier
}

const prepare = (overrides: { sentinel?: string; at?: string; generation?: number } = {}): OpsRestoreRequest => ({
	step: 'prepare',
	object: OBJECT,
	generation: overrides.generation ?? GENERATION,
	sentinel: overrides.sentinel ?? SENTINEL,
	at: overrides.at ?? AT,
})

const arm = (target: string, overrides: { generation?: number } = {}): OpsRestoreRequest => ({
	step: 'arm',
	object: OBJECT,
	generation: overrides.generation ?? GENERATION,
	sentinel: SENTINEL,
	target,
})

const verify = (sentinel = SENTINEL): OpsRestoreRequest => ({ step: 'verify', object: OBJECT, sentinel })

async function body(response: Response): Promise<unknown> {
	return JSON.parse(await response.text())
}

/** Lets the timers the step left run: the reset follows the answer. */
function afterAnswer(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0))
}

const recovered = (calls: readonly Call[]) => calls.filter((call) => call.kind === 'onNextSessionRestoreBookmark' || call.kind === 'abort')

describe('prepare', () => {
	test('writes the sentinel, then answers the current bookmark and the bookmark of the target time', async () => {
		const { target, calls, kv } = harness()
		const response = await restoreStep(target, await barrierIn('inspect'), prepare())
		expect(response.status).toBe(200)
		const ack = parseOpsRestorePrepareAck(await body(response))
		expect(ack).toEqual({ step: 'prepare', current: 'current-1', target: `at-${Date.parse(AT)}` })
		expect([...kv.values()]).toEqual([SENTINEL])
		// The pre-restore bookmark is read after the sentinel's write, so a restore to it brings the sentinel back.
		expect(calls.map((call) => call.kind)).toEqual(['getBookmarkForTime', 'kv.put', 'getCurrentBookmark'])
	})

	test('a target time outside the recovery window is refused as bookmark_unavailable and writes nothing', async () => {
		const { target, calls, kv } = harness()
		const response = await restoreStep(target, await barrierIn('inspect'), prepare({ at: OUTSIDE_WINDOW }))
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'bookmark_unavailable', table: null })
		expect(kv.size).toBe(0)
		expect(calls.some((call) => call.kind === 'kv.put')).toBe(false)
	})

	test('a target time that is not before the sentinel is refused: a restore to it would keep the sentinel', async () => {
		const { target, kv } = harness()
		const future = new Date(Date.now() + 60_000).toISOString()
		const response = await restoreStep(target, await barrierIn('inspect'), prepare({ at: future }))
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'bookmark_unavailable', table: null })
		expect(kv.size).toBe(0)
	})

	test('a repeated prepare keeps the one sentinel and answers the same target', async () => {
		const { target, kv } = harness()
		const barrier = await barrierIn('inspect')
		const first = parseOpsRestorePrepareAck(await body(await restoreStep(target, barrier, prepare())))
		const second = parseOpsRestorePrepareAck(await body(await restoreStep(target, barrier, prepare())))
		expect(first?.target).toBe(`at-${Date.parse(AT)}`)
		expect(second?.target).toBe(first?.target)
		expect([...kv.values()]).toEqual([SENTINEL])
	})
})

describe('arm', () => {
	test('arms the target, answers the undo bookmark, and resets the object only after the answer', async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect')
		const prepared = parseOpsRestorePrepareAck(await body(await restoreStep(target, barrier, prepare())))
		if (prepared === null) {
			throw new Error('prepare did not answer')
		}
		const response = await restoreStep(target, barrier, arm(prepared.target))
		expect(response.status).toBe(200)
		expect(parseOpsRestoreArmAck(await body(response))).toEqual({ step: 'arm', undo: 'undo-1' })
		expect(recovered(calls)).toEqual([{ kind: 'onNextSessionRestoreBookmark', bookmark: prepared.target }])
		await afterAnswer()
		expect(recovered(calls).map((call) => call.kind)).toEqual(['onNextSessionRestoreBookmark', 'abort'])
	})

	test('a bookmark the storage refuses is refused as bookmark_unavailable, and the object is not reset', async () => {
		const { target, calls } = harness({ refusedTarget: 'not-a-bookmark' })
		const response = await restoreStep(target, await barrierIn('inspect'), arm('not-a-bookmark'))
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'bookmark_unavailable', table: null })
		await afterAnswer()
		expect(calls.some((call) => call.kind === 'abort')).toBe(false)
	})

	test('a repeated arm, after an object that did not reset, arms the same target and resets again', async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect')
		for (let attempt = 0; attempt < 2; attempt++) {
			const response = await restoreStep(target, barrier, arm('at-1'))
			expect(parseOpsRestoreArmAck(await body(response))?.step).toBe('arm')
			await afterAnswer()
		}
		expect(recovered(calls)).toEqual([
			{ kind: 'onNextSessionRestoreBookmark', bookmark: 'at-1' },
			{ kind: 'abort', reason: expect.any(String) },
			{ kind: 'onNextSessionRestoreBookmark', bookmark: 'at-1' },
			{ kind: 'abort', reason: expect.any(String) },
		])
	})
})

describe('verify', () => {
	test('an object that did not restore still holds the sentinel', async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect')
		await restoreStep(target, barrier, prepare())
		await restoreStep(target, barrier, arm('at-1'))
		await afterAnswer()
		const writes = calls.length
		const response = await restoreStep(target, barrier, verify())
		expect(response.status).toBe(200)
		expect(parseOpsRestoreVerifyAck(await body(response))).toEqual({ step: 'verify', sentinel: 'present', bookmark: 'current-1' })
		// It writes nothing and arms nothing.
		expect(calls.slice(writes).map((call) => call.kind)).toEqual(['getCurrentBookmark'])
	})

	test("a restored object has lost the sentinel, also when it holds an earlier operation's", async () => {
		const { target, kv } = harness()
		const barrier = await barrierIn('inspect')
		// An abandoned earlier restore prepared this object before the target time.
		await restoreStep(target, barrier, prepare({ sentinel: EARLIER_SENTINEL }))
		const atTarget = new Map(kv)
		await restoreStep(target, barrier, prepare())
		await restoreStep(target, barrier, arm('at-1'))
		await afterAnswer()
		// The reset: the next session starts at the target, with the KV storage as it was then.
		kv.clear()
		for (const [key, value] of atTarget) {
			kv.set(key, value)
		}
		const ack = parseOpsRestoreVerifyAck(await body(await restoreStep(target, barrier, verify())))
		expect(ack?.sentinel).toBe('absent')
	})

	test('a repeated verify answers the same', async () => {
		const { target } = harness()
		const barrier = await barrierIn('inspect')
		await restoreStep(target, barrier, prepare())
		const first = await body(await restoreStep(target, barrier, verify()))
		const second = await body(await restoreStep(target, barrier, verify()))
		expect(parseOpsRestoreVerifyAck(first)).not.toBeNull()
		expect(second).toEqual(first)
	})
})

describe('the barrier', () => {
	for (const mode of ['open', 'read-only', 'closed'] as const) {
		test(`prepare and arm are refused as wrong_mode while the object is ${mode}`, async () => {
			const { target, calls, kv } = harness()
			const barrier = await barrierIn(mode)
			for (const step of [prepare(), arm('at-1')]) {
				const response = await restoreStep(target, barrier, step)
				expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
				expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'wrong_mode', table: null })
			}
			await afterAnswer()
			expect(kv.size).toBe(0)
			expect(calls).toEqual([])
		})
	}

	test('a step under another generation gets the stale refusal naming the published state', async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect', GENERATION + 1)
		for (const step of [prepare(), arm('at-1')]) {
			const response = await restoreStep(target, barrier, step)
			expect(response.status).toBe(OPS_STALE_STATUS)
			expect(parseOpsStaleRefusal(await body(response))).toEqual({
				refused: 'stale_generation',
				published: { generation: GENERATION + 1, mode: 'inspect' },
			})
		}
		await afterAnswer()
		expect(calls).toEqual([])
	})

	test('the object of ordinary traffic refuses prepare and arm as serving_object, even in inspect', async () => {
		const { target, calls, kv } = harness()
		const barrier = await barrierIn('inspect')
		for (const step of [prepare(), arm('at-1')]) {
			const response = await serveRestore(target, barrier, step, true)
			expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
			expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'serving_object', table: null })
		}
		await afterAnswer()
		expect(kv.size).toBe(0)
		expect(calls).toEqual([])
	})

	test('an object that never had a published state refuses as stale with none', async () => {
		const { target } = harness()
		const response = await restoreStep(target, await MaintenanceBarrier.load(memoryStore()), prepare())
		expect(response.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(await body(response))).toEqual({ refused: 'stale_generation', published: null })
	})

	test('a state R2 has not confirmed answers 503, which Control retries', async () => {
		const { target, calls } = harness()
		const barrier = await MaintenanceBarrier.load(memoryStore(true), { drainBoundMs: 10 })
		expect((await barrier.transition({ generation: GENERATION, mode: 'inspect' })).kind).toBe('failed')
		const response = await restoreStep(target, barrier, prepare())
		expect(response.status).toBe(503)
		expect(calls).toEqual([])
	})
})

test('a runtime without point-in-time recovery does not serve the operation', async () => {
	const { target, kv } = harness({ recovery: false })
	const barrier = await barrierIn('inspect')
	for (const step of [prepare(), arm('at-1'), verify()]) {
		const response = await restoreStep(target, barrier, step)
		expect(response.status).toBe(501)
		expect(await body(response)).toEqual({ refused: 'not_implemented' })
	}
	expect(kv.size).toBe(0)
})

describe('through the object', () => {
	const OPS_KEY = 'ops-key-of-the-environment-0123456789abcdef'
	const CLONE_STATE = { generation: GENERATION, mode: 'inspect' }

	/** The object `clone`, published `inspect`, over workerd's storage members and its abort, each call recorded. */
	function original(kv: Map<string, unknown>, calls: Call[]): FabrikaApplication {
		const storage = {
			...bunSqliteStorage(new BunDatabase(':memory:')),
			get: (key: string) => Promise.resolve(kv.get(key)),
			put: (key: string, value: unknown) => {
				calls.push({ kind: 'kv.put', key, value })
				kv.set(key, value)
				return Promise.resolve()
			},
			getCurrentBookmark: () => {
				calls.push({ kind: 'getCurrentBookmark' })
				return Promise.resolve('current')
			},
			getBookmarkForTime: (time: number) => {
				calls.push({ kind: 'getBookmarkForTime', time })
				return Promise.resolve(`at-${time}`)
			},
			onNextSessionRestoreBookmark: (bookmark: string) => {
				calls.push({ kind: 'onNextSessionRestoreBookmark', bookmark })
				return Promise.resolve('undo')
			},
		}
		const state: ApplicationState = {
			storage,
			blockConcurrencyWhile: (callback) => callback(),
			waitUntil: () => {},
			abort: (reason) => {
				calls.push({ kind: 'abort', reason: reason ?? '' })
			},
		}
		const bucket = {
			get: (key: string) =>
				Promise.resolve(key === OPS_STATE_KEY('clone') ? { etag: 'v1', text: () => Promise.resolve(JSON.stringify(CLONE_STATE)) } : null),
		}
		return new FabrikaApplication(state, {
			FABRIKA_PROXY_SECRET: PROXY_SECRET,
			[CLOUDFLARE_FILES_BINDING]: bucket,
			[FABRIKA_OPS_KEY_DIGESTS]: formatOpsKeyDigests([opsKeyDigest(OPS_KEY)]),
			[FABRIKA_APPLICATION_OBJECT]: 'application',
			[FABRIKA_APPLICATION_OBJECTS]: 'application,clone',
		})
	}

	function restoreRequest(step: OpsRestoreRequest): Request {
		return new Request(`${ORIGIN}/__fabrika/ops/restore`, {
			method: 'POST',
			headers: {
				[PROXY_SECRET_HEADER]: PROXY_SECRET,
				[ENDPOINT_HEADER]: OPS_ENDPOINT,
				Authorization: `Bearer ${OPS_KEY}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(step),
		})
	}

	test("prepare, arm and verify reach the object's KV, bookmarks and abort", async () => {
		const kv = new Map<string, unknown>()
		const calls: Call[] = []
		const object = original(kv, calls)
		const verifyClone = { ...verify(), object: 'clone' }
		const prepared = parseOpsRestorePrepareAck(await body(await object.fetch(restoreRequest({ ...prepare(), object: 'clone' }))))
		expect(prepared).toEqual({ step: 'prepare', current: 'current', target: `at-${Date.parse(AT)}` })
		const armed = await object.fetch(restoreRequest({ ...arm(prepared?.target ?? ''), object: 'clone' }))
		expect(parseOpsRestoreArmAck(await body(armed))).toEqual({ step: 'arm', undo: 'undo' })
		await afterAnswer()
		expect(recovered(calls)).toEqual([
			{ kind: 'onNextSessionRestoreBookmark', bookmark: `at-${Date.parse(AT)}` },
			{ kind: 'abort', reason: expect.any(String) },
		])
		expect(parseOpsRestoreVerifyAck(await body(await object.fetch(restoreRequest(verifyClone))))?.sentinel).toBe('present')
		// The next session after the reset starts at the target, before the sentinel was written.
		const restored = original(new Map(), [])
		expect(parseOpsRestoreVerifyAck(await body(await restored.fetch(restoreRequest(verifyClone))))?.sentinel).toBe('absent')
	})
})
