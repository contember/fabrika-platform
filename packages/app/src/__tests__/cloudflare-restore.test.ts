// The original object's point-in-time restore (ADR-0070 §9 step 6): `prepare` writes the operation's sentinel and
// answers the bookmarks, `arm` arms the restore and then resets the object, and `verify` tells a restored object from
// one that was not by the sentinel. Storage is bun:sqlite with an in-memory KV, and the recovery a double that records
// every call and hands out lexically ordered bookmarks, one per KV write: no local runtime restores, so the reset is
// simulated by putting the KV back to its state at the target.

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
import { ORIGIN, PROXY_SECRET } from './fixtures/implement/harness'

/** A step on an object ordinary traffic does not reach: the clone a side restore names. */
const restoreStep = (target: OpsTarget, barrier: MaintenanceBarrier, step: OpsRestoreRequest) => serveRestore(target, barrier, step, false)

const OBJECT = 'application'
const SENTINEL = '0192f0c4-7a1e-7c3b-9d2a-5e6f7a8b9c0d'
const OTHER_SENTINEL = '0192f0c4-0000-7c3b-9d2a-5e6f7a8b9c0d'
const GENERATION = 7
/** Inside the recovery window. */
const AT = '2026-10-20T08:00:00.000Z'
/** Before the window: thirty days back from the test's clock is long past this. */
const OUTSIDE_WINDOW = '2020-01-01T00:00:00.000Z'
const WINDOW_START = Date.parse('2026-01-01T00:00:00.000Z')
/** The object's position when the test starts: ten writes since its creation. */
const START = 10
/** Where the target time lies by default: before every write the test makes. */
const AT_POSITION = 5

/** The bookmark of a position: zero-padded, so lexical order is the order of positions, as Cloudflare's bookmarks are. */
const bookmark = (position: number) => `bm-${String(position).padStart(8, '0')}`

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
	/** The position `getBookmarkForTime` answers for a time inside the window, given the current one; `AT_POSITION` by default. */
	readonly lookup?: (position: number) => number | Promise<number>
	/** Runs before `onNextSessionRestoreBookmark` answers; it rejects a bookmark the storage refuses. */
	readonly arming?: (target: string) => Promise<void>
}

function harness(options: HarnessOptions = {}): Harness {
	const calls: Call[] = []
	const kv = new Map<string, unknown>()
	let position = START
	const storage = {
		...bunSqliteStorage(new BunDatabase(':memory:')),
		get: (key: string) => Promise.resolve(kv.get(key)),
		put: (key: string, value: unknown) => {
			calls.push({ kind: 'kv.put', key, value })
			kv.set(key, value)
			position++
			return Promise.resolve()
		},
	}
	const recovery: OpsRecovery = {
		getCurrentBookmark: () => {
			calls.push({ kind: 'getCurrentBookmark' })
			return Promise.resolve(bookmark(position))
		},
		getBookmarkForTime: async (time) => {
			calls.push({ kind: 'getBookmarkForTime', time })
			if (time < WINDOW_START) {
				throw new Error('the time is outside the recovery window')
			}
			return bookmark(await (options.lookup ?? (() => AT_POSITION))(position))
		},
		onNextSessionRestoreBookmark: async (target) => {
			calls.push({ kind: 'onNextSessionRestoreBookmark', bookmark: target })
			await options.arming?.(target)
			return bookmark(position)
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

/** Whether `promise` settled within a few turns of the event loop. */
async function settles(promise: Promise<unknown>): Promise<boolean> {
	let settled = false
	void promise.then(() => (settled = true), () => (settled = true))
	await Bun.sleep(20)
	return settled
}

/** The KV storage as the object's next session finds it after a restore to the state `snapshot` was taken at. */
function resetTo(kv: Map<string, unknown>, snapshot: ReadonlyMap<string, unknown>): void {
	kv.clear()
	for (const [key, value] of snapshot) {
		kv.set(key, value)
	}
}

const recovered = (calls: readonly Call[]) => calls.filter((call) => call.kind === 'onNextSessionRestoreBookmark' || call.kind === 'abort')

describe('prepare', () => {
	test("reads the current bookmark, then the target, and keeps both under the operation's own sentinel key", async () => {
		const { target, calls, kv } = harness()
		const response = await restoreStep(target, await barrierIn('inspect'), prepare())
		expect(response.status).toBe(200)
		const ack = parseOpsRestorePrepareAck(await body(response))
		expect(ack).toEqual({ step: 'prepare', current: bookmark(START), target: bookmark(AT_POSITION) })
		expect(kv.size).toBe(1)
		expect([...kv.keys()][0]).toContain(SENTINEL)
		// The current bookmark is read before the sentinel's write, so the target is ordered against a state without it.
		expect(calls.map((call) => call.kind)).toEqual(['getCurrentBookmark', 'getBookmarkForTime', 'kv.put'])
	})

	test('a target time outside the recovery window is refused as bookmark_unavailable and writes nothing', async () => {
		const { target, kv } = harness()
		const response = await restoreStep(target, await barrierIn('inspect'), prepare({ at: OUTSIDE_WINDOW }))
		expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
		expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'bookmark_unavailable', table: null })
		expect(kv.size).toBe(0)
	})

	for (const [name, lookup] of [['equal to', (position: number) => position], ['after', (position: number) => position + 1]] as const) {
		test(`a target ${name} the current bookmark is refused: a restore to it would keep the sentinel`, async () => {
			const { target, kv } = harness({ lookup })
			const response = await restoreStep(target, await barrierIn('inspect'), prepare())
			expect(response.status).toBe(OPS_DATA_REFUSED_STATUS)
			expect(parseOpsDataRefusal(await body(response))).toEqual({ refused: 'bookmark_unavailable', table: null })
			expect(kv.size).toBe(0)
		})
	}

	test('a target just before the current bookmark is accepted', async () => {
		const { target } = harness({ lookup: (position) => position - 1 })
		const ack = parseOpsRestorePrepareAck(await body(await restoreStep(target, await barrierIn('inspect'), prepare())))
		expect(ack).toEqual({ step: 'prepare', current: bookmark(START), target: bookmark(START - 1) })
	})

	test('a retried prepare answers what the first kept, though the lookup has moved past the sentinel', async () => {
		// The lookup is approximate: its second answer for the same time is newer than the sentinel's write.
		let lookups = 0
		const { target, calls, kv } = harness({ lookup: (position) => ++lookups === 1 ? position - 1 : position + 5 })
		const barrier = await barrierIn('inspect')
		const first = await body(await restoreStep(target, barrier, prepare()))
		const writes = calls.length
		const second = await body(await restoreStep(target, barrier, prepare()))
		expect(parseOpsRestorePrepareAck(first)).toEqual({ step: 'prepare', current: bookmark(START), target: bookmark(START - 1) })
		expect(second).toEqual(first)
		// The retry reads only its own key: no lookup and no write.
		expect(calls.slice(writes)).toEqual([])
		expect(kv.size).toBe(1)
	})

	test("another operation's prepare keeps this one's sentinel: prepare(A), prepare(B), verify(A) is present", async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect')
		await restoreStep(target, barrier, prepare())
		await restoreStep(target, barrier, prepare({ sentinel: OTHER_SENTINEL }))
		const ack = parseOpsRestoreVerifyAck(await body(await restoreStep(target, barrier, verify())))
		expect(ack?.sentinel).toBe('present')
		expect(calls.some((call) => call.kind === 'onNextSessionRestoreBookmark')).toBe(false)
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
		expect(parseOpsRestoreArmAck(await body(response))).toEqual({ step: 'arm', undo: bookmark(START + 1) })
		expect(recovered(calls)).toEqual([{ kind: 'onNextSessionRestoreBookmark', bookmark: prepared.target }])
		await afterAnswer()
		expect(recovered(calls).map((call) => call.kind)).toEqual(['onNextSessionRestoreBookmark', 'abort'])
	})

	test('a bookmark the storage refuses is refused as bookmark_unavailable, and the object is not reset', async () => {
		const { target, calls } = harness({ arming: () => Promise.reject(new Error('not a bookmark')) })
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
			const response = await restoreStep(target, barrier, arm(bookmark(AT_POSITION)))
			expect(parseOpsRestoreArmAck(await body(response))?.step).toBe('arm')
			await afterAnswer()
		}
		expect(recovered(calls)).toEqual([
			{ kind: 'onNextSessionRestoreBookmark', bookmark: bookmark(AT_POSITION) },
			{ kind: 'abort', reason: expect.any(String) },
			{ kind: 'onNextSessionRestoreBookmark', bookmark: bookmark(AT_POSITION) },
			{ kind: 'abort', reason: expect.any(String) },
		])
	})
})

describe('verify', () => {
	test('an object that did not restore still holds the sentinel', async () => {
		const { target, calls } = harness()
		const barrier = await barrierIn('inspect')
		await restoreStep(target, barrier, prepare())
		await restoreStep(target, barrier, arm(bookmark(AT_POSITION)))
		await afterAnswer()
		const writes = calls.length
		const response = await restoreStep(target, barrier, verify())
		expect(response.status).toBe(200)
		expect(parseOpsRestoreVerifyAck(await body(response))).toEqual({ step: 'verify', sentinel: 'present', bookmark: bookmark(START + 1) })
		// It writes nothing and arms nothing.
		expect(calls.slice(writes).map((call) => call.kind)).toEqual(['getCurrentBookmark'])
	})

	test("a restored object has lost the sentinel, also when it holds an earlier operation's", async () => {
		const { target, kv } = harness()
		const barrier = await barrierIn('inspect')
		// An abandoned earlier restore prepared this object before the target time.
		await restoreStep(target, barrier, prepare({ sentinel: OTHER_SENTINEL }))
		const atTarget = new Map(kv)
		await restoreStep(target, barrier, prepare())
		await restoreStep(target, barrier, arm(bookmark(AT_POSITION)))
		await afterAnswer()
		resetTo(kv, atTarget)
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
			for (const step of [prepare(), arm(bookmark(AT_POSITION))]) {
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
		for (const step of [prepare(), arm(bookmark(AT_POSITION))]) {
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

	test('the stale refusal comes before serving_object, and serving_object before wrong_mode', async () => {
		const { target } = harness()
		const stale = await serveRestore(target, await barrierIn('open', GENERATION + 1), prepare(), true)
		expect(stale.status).toBe(OPS_STALE_STATUS)
		const serving = await serveRestore(target, await barrierIn('open'), prepare(), true)
		expect(parseOpsDataRefusal(await body(serving))).toEqual({ refused: 'serving_object', table: null })
	})

	test('the object of ordinary traffic refuses prepare and arm as serving_object, even in inspect', async () => {
		const { target, calls, kv } = harness()
		const barrier = await barrierIn('inspect')
		for (const step of [prepare(), arm(bookmark(AT_POSITION))]) {
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

	test('a state R2 has not confirmed is refused as stale, naming what R2 holds', async () => {
		const { target, calls } = harness()
		const barrier = await MaintenanceBarrier.load(memoryStore(true), { drainBoundMs: 10 })
		expect((await barrier.transition({ generation: GENERATION, mode: 'inspect' })).kind).toBe('failed')
		const response = await restoreStep(target, barrier, prepare())
		expect(response.status).toBe(OPS_STALE_STATUS)
		expect(parseOpsStaleRefusal(await body(response))).toEqual({ refused: 'stale_generation', published: null })
		expect(calls).toEqual([])
	})

	test('a transition requested while prepare waits on a lookup is acknowledged only after prepare answers', async () => {
		const lookup = Promise.withResolvers<number>()
		const { target, kv } = harness({ lookup: () => lookup.promise })
		const barrier = await barrierIn('inspect')
		const prepared = restoreStep(target, barrier, prepare())
		const opened = barrier.transition({ generation: GENERATION + 1, mode: 'open' })
		expect(await settles(opened)).toBe(false)
		lookup.resolve(AT_POSITION)
		expect((await prepared).status).toBe(200)
		expect((await opened).kind).toBe('acknowledged')
		expect(kv.size).toBe(1)
		// The step that arrives after the transition is fenced by it.
		const late = await restoreStep(target, barrier, prepare({ sentinel: OTHER_SENTINEL }))
		expect(parseOpsStaleRefusal(await body(late))).toEqual({ refused: 'stale_generation', published: { generation: GENERATION + 1, mode: 'open' } })
		expect(kv.size).toBe(1)
	})

	test('a prepare requested while a transition publishes runs after it, and is fenced by it', async () => {
		const { target, kv } = harness()
		const inner = memoryStore()
		let gate = Promise.resolve()
		const store: MaintenanceStore = {
			read: inner.read,
			put: async (state, version) => {
				await gate
				return await inner.put(state, version)
			},
		}
		const barrier = await MaintenanceBarrier.load(store, { drainBoundMs: 10 })
		expect((await barrier.transition({ generation: GENERATION, mode: 'inspect' })).kind).toBe('acknowledged')
		const held = Promise.withResolvers<void>()
		gate = held.promise
		const opened = barrier.transition({ generation: GENERATION + 1, mode: 'open' })
		const prepared = restoreStep(target, barrier, prepare())
		expect(await settles(prepared)).toBe(false)
		held.resolve()
		expect((await opened).kind).toBe('acknowledged')
		expect((await prepared).status).toBe(OPS_STALE_STATUS)
		expect(kv.size).toBe(0)
	})

	test('a transition requested while arm runs is acknowledged only after the object was reset', async () => {
		const arming = Promise.withResolvers<void>()
		const { target, calls } = harness({ arming: () => arming.promise })
		const barrier = await barrierIn('inspect')
		const armed = restoreStep(target, barrier, arm(bookmark(AT_POSITION)))
		const order: string[] = []
		const reset = () => calls.some((call) => call.kind === 'abort')
		const opened = barrier.transition({ generation: GENERATION + 1, mode: 'open' }).then((result) => {
			order.push(`transition ${result.kind}, reset before it: ${reset()}`)
		})
		expect(await settles(opened)).toBe(false)
		arming.resolve()
		expect(parseOpsRestoreArmAck(await body(await armed))?.step).toBe('arm')
		order.push(`answered, reset before it: ${reset()}`)
		await opened
		expect(order).toEqual(['answered, reset before it: false', 'transition acknowledged, reset before it: true'])
	})
})

test('a runtime without point-in-time recovery does not serve the operation', async () => {
	const { target, kv } = harness({ recovery: false })
	const barrier = await barrierIn('inspect')
	for (const step of [prepare(), arm(bookmark(AT_POSITION)), verify()]) {
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
				return Promise.resolve(bookmark(START))
			},
			getBookmarkForTime: (time: number) => {
				calls.push({ kind: 'getBookmarkForTime', time })
				return Promise.resolve(bookmark(AT_POSITION))
			},
			onNextSessionRestoreBookmark: (target: string) => {
				calls.push({ kind: 'onNextSessionRestoreBookmark', bookmark: target })
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
		expect(prepared).toEqual({ step: 'prepare', current: bookmark(START), target: bookmark(AT_POSITION) })
		const armed = await object.fetch(restoreRequest({ ...arm(prepared?.target ?? ''), object: 'clone' }))
		expect(parseOpsRestoreArmAck(await body(armed))).toEqual({ step: 'arm', undo: 'undo' })
		await afterAnswer()
		expect(recovered(calls)).toEqual([
			{ kind: 'onNextSessionRestoreBookmark', bookmark: bookmark(AT_POSITION) },
			{ kind: 'abort', reason: expect.any(String) },
		])
		expect(parseOpsRestoreVerifyAck(await body(await object.fetch(restoreRequest(verifyClone))))?.sentinel).toBe('present')
		// The next session after the reset starts at the target, before the sentinel was written.
		const restored = original(new Map(), [])
		expect(parseOpsRestoreVerifyAck(await body(await restored.fetch(restoreRequest(verifyClone))))?.sentinel).toBe('absent')
	})
})
