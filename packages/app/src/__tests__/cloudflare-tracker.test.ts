// The isolate's pending-work tracker (ADR-0070 §10): while it is on, every live timer and `waitUntil` promise is listed
// with the scrubbed, bounded stack that registered it, oldest first and capped; every object of the isolate shares it,
// and a fresh tracker, as after the isolate's eviction, lists nothing.

import { OPS_TIMER_STACK_MAX_BYTES, OPS_TIMER_STACK_MAX_FRAMES, OPS_TIMERS_CAP, type OpsTimersView, parseOpsTimersView } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type ApplicationState, trackedState } from '../cloudflare/application'
import { serveTimers, type TimerScope, type TimerTracker, timerTracker } from '../cloudflare/tracker'
import { REDACTED, secretScrubber } from '../jobs/scrub'

const NOW = Date.parse('2026-10-25T08:00:00.000Z')
const SCRUBBER = secretScrubber([])

/** A handle shaped like Bun's: an object that a clear also accepts as its number. */
interface ManualHandle {
	readonly id: number
	[Symbol.toPrimitive](): number
}

/** Timers that fire only when the test says so, calling the handler with its handle as the receiver, as Bun does. */
class ManualTimers implements TimerScope {
	readonly #handlers = new Map<number, { readonly run: () => void; readonly repeats: boolean }>()
	#next = 1

	setTimeout(handler: unknown, _delay?: unknown, ...args: unknown[]): unknown {
		return this.#schedule(handler, args, false)
	}

	setInterval(handler: unknown, _delay?: unknown, ...args: unknown[]): unknown {
		return this.#schedule(handler, args, true)
	}

	clearTimeout(id?: unknown): void {
		this.#handlers.delete(Number(id))
	}

	clearInterval(id?: unknown): void {
		this.#handlers.delete(Number(id))
	}

	fire(handle: unknown): void {
		const id = Number(handle)
		const handler = this.#handlers.get(id)
		if (handler === undefined) throw new Error(`timer ${id} is not scheduled`)
		if (!handler.repeats) this.#handlers.delete(id)
		handler.run()
	}

	#schedule(handler: unknown, args: readonly unknown[], repeats: boolean): ManualHandle {
		const id = this.#next++
		const handle: ManualHandle = { id, [Symbol.toPrimitive]: () => id }
		this.#handlers.set(id, { run: () => typeof handler === 'function' && Reflect.apply(handler, handle, args), repeats })
		return handle
	}
}

function tracked(scope: TimerScope, now: () => number = () => NOW): TimerTracker {
	const tracker = timerTracker(scope, now, SCRUBBER)
	tracker.track(true)
	return tracker
}

function parsed(view: OpsTimersView): OpsTimersView {
	const answer = parseOpsTimersView(JSON.parse(JSON.stringify(view)))
	if (answer === null) throw new Error('the view does not parse with the wire parser')
	return answer
}

async function served(request: Parameters<typeof serveTimers>[0]): Promise<OpsTimersView | null> {
	const response = serveTimers(request)
	expect(response.status).toBe(200)
	return parseOpsTimersView(await response.json())
}

/** Not a tail call, so Bun's proper tail calls keep this frame in the stack the tracker records. */
function leakAHandlerDeadline(scope: TimerScope): unknown {
	const handles = [scope.setTimeout(() => {}, 10_000)]
	return handles[0]
}

function handAReportToWaitUntil(tracker: TimerTracker, promise: Promise<void>): Promise<void> {
	const handed = [tracker.pending(promise)]
	return handed[0] ?? promise
}

/** A timer started from a function of that name, which a runtime may compute from data. */
function leakFromFunctionNamed(scope: TimerScope, name: string): void {
	const named: Record<string, () => unknown> = {
		[name]: () => {
			const handles = [scope.setTimeout(() => {}, 1)]
			return handles[0]
		},
	}
	const start = named[name]
	if (start === undefined) throw new Error('the named function is missing')
	const started = [start()]
	expect(started).toHaveLength(1)
}

/**
 * The unhandled rejections a process hears when it hands a rejecting promise through `pending` and drops the answer,
 * as a runtime that only awaits `waitUntil` work does. A process of its own: bun:test fails on any unhandled rejection.
 */
function unhandledRejections(tracking: boolean): string[] {
	const script = `
		import { timerTracker } from ${JSON.stringify(join(import.meta.dir, '../cloudflare/tracker.ts'))}
		import { secretScrubber } from ${JSON.stringify(join(import.meta.dir, '../jobs/scrub.ts'))}
		process.on('unhandledRejection', (reason) => console.log('unhandled: ' + reason.message))
		const scope = { setTimeout() {}, setInterval() {}, clearTimeout() {}, clearInterval() {} }
		const tracker = timerTracker(scope, () => Date.now(), secretScrubber([]))
		tracker.track(${tracking})
		void tracker.pending(Promise.reject(new Error('the background work failed')))
		await Bun.sleep(20)
	`
	const child = Bun.spawnSync([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' })
	expect(child.stderr.toString()).toBe('')
	return child.stdout.toString().split('\n').filter((line) => line !== '')
}

describe('the timer tracker', () => {
	test('lists a leaked timeout and interval with the stack that created them, oldest first', () => {
		const scope = new ManualTimers()
		const tracker = tracked(scope)
		leakAHandlerDeadline(scope)
		scope.setInterval(() => {}, 60_000)

		const view = parsed(tracker.view())
		expect(view.tracking).toBe(true)
		expect(view.omitted).toBe(0)
		expect(view.timers.map(({ kind, delayMs, since }) => ({ kind, delayMs, since }))).toEqual([
			{ kind: 'timeout', delayMs: 10_000, since: '2026-10-25T08:00:00.000Z' },
			{ kind: 'interval', delayMs: 60_000, since: '2026-10-25T08:00:00.000Z' },
		])
		expect(view.timers[0]?.stack).toContain('leakAHandlerDeadline')
	})

	test('drops a cleared timer, a fired timeout and a cleared interval, and keeps a firing interval', () => {
		const scope = new ManualTimers()
		const tracker = tracked(scope)
		const cleared = scope.setTimeout(() => {}, 100)
		let fired = 0
		const firing = scope.setTimeout(() => fired++, 200)
		const repeating = scope.setInterval(() => fired++, 300)
		const stopped = scope.setInterval(() => {}, 400)

		scope.clearTimeout(cleared)
		scope.fire(firing)
		scope.fire(repeating)
		scope.clearTimeout(stopped)

		expect(fired).toBe(2)
		expect(parsed(tracker.view()).timers.map(({ kind, delayMs }) => ({ kind, delayMs }))).toEqual([{ kind: 'interval', delayMs: 300 }])
	})

	test("drops a timer cleared by its handle's number, through either clear", () => {
		const scope = new ManualTimers()
		const tracker = tracked(scope)
		const timeout = scope.setTimeout(() => {}, 100)
		const interval = scope.setInterval(() => {}, 200)
		const crossed = scope.setTimeout(() => {}, 300)

		scope.clearTimeout(Number(timeout))
		scope.clearInterval(Number(interval))
		scope.clearInterval(Number(crossed))

		expect(parsed(tracker.view()).timers).toEqual([])
	})

	test("hands the handler the runtime's receiver and arguments, for a timeout and an interval", () => {
		const scope = new ManualTimers()
		tracked(scope)
		const calls: { readonly receiver: unknown; readonly args: readonly unknown[] }[] = []
		function handler(this: unknown, ...args: unknown[]): void {
			calls.push({ receiver: this, args })
		}
		const timeout = scope.setTimeout(handler, 5, 'a', 2)
		const interval = scope.setInterval(handler, 5, 'b')
		scope.fire(timeout)
		scope.fire(interval)

		expect(calls).toEqual([
			{ receiver: timeout, args: ['a', 2] },
			{ receiver: interval, args: ['b'] },
		])
	})

	test('lists a waitUntil promise until it settles, and answers a chain that settles as it does', async () => {
		const tracker = tracked(new ManualTimers())
		let resolve: () => void = () => {}
		const pending = new Promise<void>((done) => {
			resolve = done
		})
		const handed = handAReportToWaitUntil(tracker, pending)
		const failure = new Error('the report failed')
		const failing = tracker.pending(Promise.reject(failure))

		expect(failing).rejects.toBe(failure)
		await failing.catch(() => {})
		const view = parsed(tracker.view())
		expect(view.timers.map(({ kind, delayMs }) => ({ kind, delayMs }))).toEqual([{ kind: 'waitUntil', delayMs: null }])
		expect(view.timers[0]?.stack).toContain('handAReportToWaitUntil')

		resolve()
		await handed
		expect(parsed(tracker.view()).timers).toEqual([])
		expect(await tracker.pending(Promise.resolve('value'))).toBe('value')
	})

	test('leaves an unhandled rejection of a waitUntil promise unhandled, once, tracking on and off', () => {
		expect(unhandledRejections(true)).toEqual(['unhandled: the background work failed'])
		expect(unhandledRejections(false)).toEqual(['unhandled: the background work failed'])
	})

	test('keeps at most the frames nearest the call, within the byte bound', () => {
		const scope = new ManualTimers()
		const tracker = tracked(scope)
		const limit = Error.stackTraceLimit
		Error.stackTraceLimit = 200
		try {
			const deep = (depth: number): unknown => {
				const handles = [depth === 0 ? leakAHandlerDeadline(scope) : deep(depth - 1)]
				return handles[0]
			}
			deep(100)
			leakFromFunctionNamed(scope, `huge${'x'.repeat(3 * OPS_TIMER_STACK_MAX_BYTES)}`)
		} finally {
			Error.stackTraceLimit = limit
		}

		const [deepStack, hugeStack] = parsed(tracker.view()).timers.map(({ stack }) => stack)
		expect(deepStack?.split('\n')).toHaveLength(OPS_TIMER_STACK_MAX_FRAMES)
		expect(deepStack).toContain('leakAHandlerDeadline')
		expect(hugeStack).toContain('hugexxx')
		expect(new TextEncoder().encode(hugeStack).length).toBeLessThanOrEqual(OPS_TIMER_STACK_MAX_BYTES)
	})

	test('scrubs a credential a frame carries', () => {
		const scope = new ManualTimers()
		const tracker = tracked(scope)
		const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJlLXZhbHVl'
		leakFromFunctionNamed(scope, `deliver ${token}`)
		leakFromFunctionNamed(scope, 'fetch https://operator:hunter2-password@db.example.test/rows?token=abcdef123456')

		const [jwt, url] = parsed(tracker.view()).timers.map(({ stack }) => stack)
		expect(jwt).toContain(`deliver ${REDACTED}`)
		expect(jwt).not.toContain(token)
		expect(url).toContain(`https://${REDACTED}@db.example.test/rows?token=${REDACTED}`)
		expect(url).not.toContain('hunter2-password')
		expect(url).not.toContain('abcdef123456')
	})

	test('lists at most the cap, the oldest first, and counts the rest', () => {
		const scope = new ManualTimers()
		let clock = NOW
		const tracker = tracked(scope, () => clock++)
		for (let index = 0; index < OPS_TIMERS_CAP + 37; index++) {
			scope.setTimeout(() => {}, index)
		}

		const view = parsed(tracker.view())
		expect(view.timers).toHaveLength(OPS_TIMERS_CAP)
		expect(view.omitted).toBe(37)
		expect(view.timers[0]?.delayMs).toBe(0)
		expect(view.timers.at(-1)?.delayMs).toBe(OPS_TIMERS_CAP - 1)
	})

	test("a fresh tracker, as after the isolate's eviction, is off and lists nothing", () => {
		const scope = new ManualTimers()
		const evicted = tracked(scope)
		leakAHandlerDeadline(scope)
		evicted.track(false)

		const fresh = timerTracker(new ManualTimers(), () => NOW, SCRUBBER)
		expect(parsed(fresh.view())).toEqual({ tracking: false, timers: [], omitted: 0 })
	})

	test('records nothing while off, and switching off restores the timers it wrapped', () => {
		const scope = new ManualTimers()
		const { setTimeout, setInterval, clearTimeout, clearInterval } = scope
		const tracker = timerTracker(scope, () => NOW, SCRUBBER)
		leakAHandlerDeadline(scope)
		const untracked = Promise.resolve()
		expect(tracker.pending(untracked)).toBe(untracked)
		expect(parsed(tracker.view())).toEqual({ tracking: false, timers: [], omitted: 0 })

		tracker.track(true)
		tracker.track(true)
		leakAHandlerDeadline(scope)
		expect(parsed(tracker.view()).timers).toHaveLength(1)

		tracker.track(false)
		expect(scope.setTimeout).toBe(setTimeout)
		expect(scope.setInterval).toBe(setInterval)
		expect(scope.clearTimeout).toBe(clearTimeout)
		expect(scope.clearInterval).toBe(clearInterval)
		expect(parsed(tracker.view())).toEqual({ tracking: false, timers: [], omitted: 0 })
	})

	test('a waitUntil promise handed while off is not listed after switching on', () => {
		const scope = new ManualTimers()
		const tracker = timerTracker(scope, () => NOW, SCRUBBER)
		tracker.pending(new Promise<void>(() => {}))
		tracker.track(true)
		expect(parsed(tracker.view()).timers).toEqual([])
	})
})

describe('the timers operation', () => {
	afterEach(() => {
		serveTimers({ object: 'application', track: false })
	})

	test('switches the isolate tracker on, lists a leaked global timer, and switches it off', async () => {
		const original = globalThis.setTimeout
		expect(await served({ object: 'application', track: true })).toEqual({ tracking: true, timers: [], omitted: 0 })
		expect(globalThis.setTimeout).not.toBe(original)

		const isolate: TimerScope = globalThis
		const leaked = leakAHandlerDeadline(isolate)
		const view = await served({ object: 'application', track: null })
		expect(view?.timers.map(({ kind, delayMs }) => ({ kind, delayMs }))).toEqual([{ kind: 'timeout', delayMs: 10_000 }])
		expect(view?.timers[0]?.stack).toContain('leakAHandlerDeadline')

		isolate.clearTimeout(leaked)
		expect((await served({ object: 'application', track: null }))?.timers).toEqual([])

		expect(await served({ object: 'application', track: false })).toEqual({ tracking: false, timers: [], omitted: 0 })
		expect(globalThis.setTimeout).toBe(original)
	})

	test("the object's every waitUntil promise reaches the isolate tracker, and the rest of its state is the runtime's", async () => {
		const handed: Promise<unknown>[] = []
		const aborted: { readonly receiver: unknown; readonly reason: string | undefined }[] = []
		const runtime: ApplicationState = {
			storage: {
				sql: { exec: () => ({ toArray: () => [], rowsWritten: 0 }) },
				transaction: (closure) => closure(),
				transactionSync: (closure) => closure(),
			},
			blockConcurrencyWhile: (callback) => callback(),
			waitUntil: (promise) => {
				handed.push(promise)
			},
			abort(reason) {
				aborted.push({ receiver: this, reason })
			},
		}
		const state = trackedState(runtime)
		expect(state.storage).toBe(runtime.storage)
		expect(await state.blockConcurrencyWhile(() => Promise.resolve(7))).toBe(7)
		state.abort?.('restore')
		expect(aborted).toEqual([{ receiver: runtime, reason: 'restore' }])

		await served({ object: 'application', track: true })
		let settle = () => {}
		state.waitUntil(
			new Promise<void>((resolve) => {
				settle = resolve
			}),
		)
		expect(handed).toHaveLength(1)
		expect((await served({ object: 'application', track: null }))?.timers.map(({ kind }) => kind)).toEqual(['waitUntil'])
		settle()
		await handed[0]
		expect((await served({ object: 'application', track: false }))?.timers).toEqual([])
	})

	test("drops a Bun timer cleared by its handle's number, and hands its callback the handle", async () => {
		await served({ object: 'application', track: true })
		const isolate: TimerScope = globalThis
		const timeout = isolate.setTimeout(() => {}, 10_000)
		const interval = isolate.setInterval(() => {}, 10_000)
		expect((await served({ object: 'application', track: null }))?.timers).toHaveLength(2)
		isolate.clearTimeout(Number(timeout))
		isolate.clearInterval(Number(interval))
		expect((await served({ object: 'application', track: null }))?.timers).toEqual([])

		const receivers: unknown[] = []
		let started: unknown = null
		await new Promise<void>((done) => {
			started = isolate.setTimeout(function(this: unknown) {
				receivers.push(this)
				done()
			}, 0)
		})
		let repeating: unknown = null
		await new Promise<void>((done) => {
			repeating = isolate.setInterval(function(this: unknown) {
				receivers.push(this)
				isolate.clearInterval(this)
				done()
			}, 0)
		})
		expect(receivers).toEqual([started, repeating])
		expect((await served({ object: 'application', track: null }))?.timers).toEqual([])
	})

	test('every object of the isolate shares the switch and the records', async () => {
		await served({ object: 'application', track: true })
		const isolate: TimerScope = globalThis
		const leaked = leakAHandlerDeadline(isolate)

		const fromRehearsal = await served({ object: 'rehearsal', track: null })
		expect(fromRehearsal?.tracking).toBe(true)
		expect(fromRehearsal?.timers.map(({ kind }) => kind)).toEqual(['timeout'])

		expect(await served({ object: 'rehearsal', track: false })).toEqual({ tracking: false, timers: [], omitted: 0 })
		expect(await served({ object: 'application', track: null })).toEqual({ tracking: false, timers: [], omitted: 0 })
		isolate.clearTimeout(leaked)
	})
})
