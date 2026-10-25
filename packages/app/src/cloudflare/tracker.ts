// The object's pending-work tracker (ADR-0069 §2, ADR-0070 §10): the ops operation `timers`, diagnostics only. While
// it is on, it wraps the isolate's global timers and records each live timer and each `waitUntil` promise with the stack
// that registered it. It lives in memory: an eviction drops it, and the next isolate's tracker starts off.

import { OPS_TIMERS_CAP, type OpsTimer, type OpsTimersRequest, type OpsTimersView } from '@fabrika/auth-core'
import { jsonResponse } from '../errors.js'

/** The global timers the tracker wraps while it is on; `globalThis` fits it. */
export interface TimerScope {
	setTimeout(handler: unknown, delay?: unknown, ...args: unknown[]): unknown
	setInterval(handler: unknown, delay?: unknown, ...args: unknown[]): unknown
	clearTimeout(id?: unknown): void
	clearInterval(id?: unknown): void
}

export interface TimerTracker {
	/** Switches tracking on (wrapping the scope's timers) or off (restoring them and forgetting every record). */
	track(on: boolean): void
	/** Records `promise` until it settles while tracking is on; returns it unchanged. */
	pending<T>(promise: Promise<T>): Promise<T>
	/** The live records, oldest first, at most `OPS_TIMERS_CAP` of them. */
	view(): OpsTimersView
}

type Caller = (...args: never[]) => unknown

/** A tracker over `scope`'s timers, off until `track(true)`. */
export function timerTracker(scope: TimerScope, now: () => number): TimerTracker {
	// Keyed by the handle the timer answered, or by a fresh object for a promise; a Map keeps creation order.
	const live = new Map<unknown, OpsTimer>()
	/** The scope's own timers and the tracker's wrappers over them, while tracking is on. */
	let installed: { readonly own: TimerScope; readonly wrapped: TimerScope } | null = null

	const record = (kind: OpsTimer['kind'], delay: unknown, caller: Caller): OpsTimer => ({
		kind,
		since: new Date(now()).toISOString(),
		delayMs: kind === 'waitUntil' ? null : delayOf(delay),
		stack: stackBelow(caller),
	})

	// A wrapper that other code kept after `track(false)` still works; it records only while tracking is on.
	const wrap = (own: TimerScope): TimerScope => {
		/** The record of a timer about to start, taken in the wrapper's own frame; `null` when nothing is recorded. */
		const recorded = (kind: 'timeout' | 'interval', handler: unknown, delay: unknown, caller: Caller): OpsTimer | null =>
			installed === null || typeof handler !== 'function' ? null : record(kind, delay, caller)
		const schedule = (kind: 'timeout' | 'interval', entry: OpsTimer | null, handler: unknown, delay: unknown, args: readonly unknown[]): unknown => {
			const start = kind === 'timeout' ? own.setTimeout : own.setInterval
			if (entry === null || typeof handler !== 'function') {
				return Reflect.apply(start, scope, [handler, delay, ...args])
			}
			let id: unknown
			const run = (...callArgs: unknown[]): unknown => {
				if (kind === 'timeout') {
					live.delete(id)
				}
				return Reflect.apply(handler, undefined, callArgs)
			}
			id = Reflect.apply(start, scope, [run, delay, ...args])
			live.set(id, entry)
			return id
		}
		const clear = (stop: (id?: unknown) => void, id: unknown): void => {
			// A timeout's and an interval's handles share one pool, so either clear ends either kind.
			live.delete(id)
			Reflect.apply(stop, scope, [id])
		}
		// The stack is taken before `schedule`: a proper tail call (JavaScriptCore) would drop the frame `stackBelow` cuts at.
		return {
			setTimeout: function setTimeout(handler, delay, ...args) {
				return schedule('timeout', recorded('timeout', handler, delay, setTimeout), handler, delay, args)
			},
			setInterval: function setInterval(handler, delay, ...args) {
				return schedule('interval', recorded('interval', handler, delay, setInterval), handler, delay, args)
			},
			clearTimeout: (id) => clear(own.clearTimeout, id),
			clearInterval: (id) => clear(own.clearInterval, id),
		}
	}

	const pending = <T>(promise: Promise<T>): Promise<T> => {
		if (installed === null) {
			return promise
		}
		const key = {}
		live.set(key, record('waitUntil', null, pending))
		const settle = () => live.delete(key)
		promise.then(settle, settle)
		return promise
	}

	return {
		track(on) {
			if (on && installed === null) {
				const own = { setTimeout: scope.setTimeout, setInterval: scope.setInterval, clearTimeout: scope.clearTimeout, clearInterval: scope.clearInterval }
				const wrapped = wrap(own)
				installed = { own, wrapped }
				scope.setTimeout = wrapped.setTimeout
				scope.setInterval = wrapped.setInterval
				scope.clearTimeout = wrapped.clearTimeout
				scope.clearInterval = wrapped.clearInterval
			} else if (!on && installed !== null) {
				const { own, wrapped } = installed
				// Restores only what is still the tracker's own, so a later wrapper by other code stays in place.
				if (scope.setTimeout === wrapped.setTimeout) scope.setTimeout = own.setTimeout
				if (scope.setInterval === wrapped.setInterval) scope.setInterval = own.setInterval
				if (scope.clearTimeout === wrapped.clearTimeout) scope.clearTimeout = own.clearTimeout
				if (scope.clearInterval === wrapped.clearInterval) scope.clearInterval = own.clearInterval
				installed = null
				live.clear()
			}
		},
		pending,
		view() {
			const timers = [...live.values()]
			return { tracking: installed !== null, timers: timers.slice(0, OPS_TIMERS_CAP), omitted: Math.max(0, timers.length - OPS_TIMERS_CAP) }
		},
	}
}

/** The delay a timer was asked for, in whole milliseconds: what the runtime coerces to a number, else 0. */
function delayOf(delay: unknown): number {
	const ms = typeof delay === 'number' || typeof delay === 'string' ? Number(delay) : 0
	return Number.isFinite(ms) && ms > 0 ? Math.min(Math.trunc(ms), Number.MAX_SAFE_INTEGER) : 0
}

/** The stack of the code that called `caller`, without the tracker's own frames. */
function stackBelow(caller: Caller): string {
	const holder: { stack?: string } = {}
	Error.captureStackTrace(holder, caller)
	return (holder.stack ?? '').replace(/^Error\n/, '')
}

/** The isolate's tracker: a fresh isolate, as after an eviction, starts with it off. */
const isolateTracker = timerTracker(globalThis, () => Date.now())

/** Records a promise the object hands to `waitUntil` while the tracker is on; returns it unchanged. */
export function trackPending<T>(promise: Promise<T>): Promise<T> {
	return isolateTracker.pending(promise)
}

/** The object's live timers and `waitUntil` promises; `track` switches the tracker on or off first. */
export function serveTimers(request: OpsTimersRequest): Response {
	if (request.track !== null) {
		isolateTracker.track(request.track)
	}
	return jsonResponse(isolateTracker.view(), 200)
}
