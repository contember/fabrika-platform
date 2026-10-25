// The object's pending-work tracker (ADR-0070 §10): while it is on, every live timer and `waitUntil` promise is listed
// with the stack that registered it, oldest first and capped; a fresh tracker, as after an eviction, lists nothing.

import { OPS_TIMERS_CAP, type OpsTimersView, parseOpsTimersView } from '@fabrika/auth-core'
import { afterEach, describe, expect, test } from 'bun:test'
import { serveTimers, type TimerScope, type TimerTracker, timerTracker } from '../cloudflare/tracker'

const NOW = Date.parse('2026-10-25T08:00:00.000Z')

/** Timers that fire only when the test says so, with the handle shapes workerd answers (numbers). */
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
		if (typeof id === 'number') this.#handlers.delete(id)
	}

	clearInterval(id?: unknown): void {
		if (typeof id === 'number') this.#handlers.delete(id)
	}

	fire(id: unknown): void {
		if (typeof id !== 'number') throw new Error('not a handle of these timers')
		const handler = this.#handlers.get(id)
		if (handler === undefined) throw new Error(`timer ${id} is not scheduled`)
		if (!handler.repeats) this.#handlers.delete(id)
		handler.run()
	}

	#schedule(handler: unknown, args: readonly unknown[], repeats: boolean): number {
		const id = this.#next++
		this.#handlers.set(id, { run: () => typeof handler === 'function' && Reflect.apply(handler, undefined, args), repeats })
		return id
	}
}

function parsed(view: OpsTimersView): OpsTimersView {
	const answer = parseOpsTimersView(JSON.parse(JSON.stringify(view)))
	if (answer === null) throw new Error('the view does not parse with the wire parser')
	return answer
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

describe('the timer tracker', () => {
	test('lists a leaked timeout and interval with the stack that created them, oldest first', () => {
		const scope = new ManualTimers()
		const tracker = timerTracker(scope, () => NOW)
		tracker.track(true)
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
		const tracker = timerTracker(scope, () => NOW)
		tracker.track(true)
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

	test('passes the arguments and the handler through to the timer it wraps', () => {
		const scope = new ManualTimers()
		const tracker = timerTracker(scope, () => NOW)
		tracker.track(true)
		const received: unknown[] = []
		const id = scope.setTimeout((first: unknown, second: unknown) => received.push(first, second), 5, 'a', 2)
		scope.fire(id)
		expect(received).toEqual(['a', 2])
	})

	test('lists a waitUntil promise until it settles, a rejected one included', async () => {
		const scope = new ManualTimers()
		const tracker = timerTracker(scope, () => NOW)
		tracker.track(true)
		let resolve: () => void = () => {}
		const pending = new Promise<void>((done) => {
			resolve = done
		})
		const handed = handAReportToWaitUntil(tracker, pending)
		const failing = tracker.pending(Promise.reject(new Error('the report failed')))

		expect(handed).toBe(pending)
		await failing.catch(() => {})
		const view = parsed(tracker.view())
		expect(view.timers.map(({ kind, delayMs }) => ({ kind, delayMs }))).toEqual([{ kind: 'waitUntil', delayMs: null }])
		expect(view.timers[0]?.stack).toContain('handAReportToWaitUntil')

		resolve()
		await handed
		expect(parsed(tracker.view()).timers).toEqual([])
	})

	test('lists at most the cap, the oldest first, and counts the rest', () => {
		const scope = new ManualTimers()
		let clock = NOW
		const tracker = timerTracker(scope, () => clock++)
		tracker.track(true)
		for (let index = 0; index < OPS_TIMERS_CAP + 37; index++) {
			scope.setTimeout(() => {}, index)
		}

		const view = parsed(tracker.view())
		expect(view.timers).toHaveLength(OPS_TIMERS_CAP)
		expect(view.omitted).toBe(37)
		expect(view.timers[0]?.delayMs).toBe(0)
		expect(view.timers.at(-1)?.delayMs).toBe(OPS_TIMERS_CAP - 1)
	})

	test('a fresh tracker, as after an eviction, is off and lists nothing', () => {
		const scope = new ManualTimers()
		const evicted = timerTracker(scope, () => NOW)
		evicted.track(true)
		leakAHandlerDeadline(scope)
		evicted.track(false)

		const fresh = timerTracker(new ManualTimers(), () => NOW)
		expect(parsed(fresh.view())).toEqual({ tracking: false, timers: [], omitted: 0 })
	})

	test('records nothing while off, and switching off restores the timers it wrapped', async () => {
		const scope = new ManualTimers()
		const { setTimeout, setInterval, clearTimeout, clearInterval } = scope
		const tracker = timerTracker(scope, () => NOW)
		leakAHandlerDeadline(scope)
		expect(tracker.pending(Promise.resolve())).toBeInstanceOf(Promise)
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

	test('a waitUntil promise handed while off is not listed after switching on', async () => {
		const scope = new ManualTimers()
		const tracker = timerTracker(scope, () => NOW)
		const pending = tracker.pending(new Promise<void>(() => {}))
		tracker.track(true)
		expect(pending).toBeInstanceOf(Promise)
		expect(parsed(tracker.view()).timers).toEqual([])
	})
})

describe('the timers operation', () => {
	afterEach(() => {
		serveTimers({ object: 'application', track: false })
	})

	test('switches the isolate tracker on, lists a leaked global timer, and switches it off', async () => {
		const original = globalThis.setTimeout
		const on = parseOpsTimersView(await serveTimers({ object: 'application', track: true }).json())
		expect(on).toEqual({ tracking: true, timers: [], omitted: 0 })
		expect(globalThis.setTimeout).not.toBe(original)

		const isolate: TimerScope = globalThis
		const leaked = leakAHandlerDeadline(isolate)
		const read = serveTimers({ object: 'application', track: null })
		expect(read.status).toBe(200)
		const view = parseOpsTimersView(await read.json())
		expect(view?.timers.map(({ kind, delayMs }) => ({ kind, delayMs }))).toEqual([{ kind: 'timeout', delayMs: 10_000 }])
		expect(view?.timers[0]?.stack).toContain('leakAHandlerDeadline')

		isolate.clearTimeout(leaked)
		expect(parseOpsTimersView(await serveTimers({ object: 'application', track: null }).json())?.timers).toEqual([])

		const off = parseOpsTimersView(await serveTimers({ object: 'application', track: false }).json())
		expect(off).toEqual({ tracking: false, timers: [], omitted: 0 })
		expect(globalThis.setTimeout).toBe(original)
	})
})
