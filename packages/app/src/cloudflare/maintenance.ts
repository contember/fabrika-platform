// The object's maintenance barrier (ADR-0069 §3): its mode and generation, whether R2 holds them, the transitions
// Control drives, the drain of what runs, and the write fence every invocation checks. The durable copy is an R2
// object in the environment's bucket, never SQLite or KV, which point-in-time recovery rewinds; so is the generation
// since which the object has written nothing (ADR-0070 §2), in an object of its own that no older release reads.

import {
	OPS_MODES,
	OPS_STATE_KEY,
	type OpsMaintenance,
	type OpsMode,
	type OpsPublishedState,
	type OpsStateAck,
	opsTransitionRefused,
} from '@fabrika/auth-core'
import type { InvocationAdmission, InvocationGate, InvocationKind } from '../implement/dispatch.js'
import { LEASE_GRACE_MS } from '../jobs/runner.js'
import { method } from './bindings.js'

/** A handler's share of the drain's bound; a job's lease grace follows it, as Control's request timeout assumes. */
const DRAIN_HANDLER_MS = 25_000
export const DRAIN_BOUND_MS = DRAIN_HANDLER_MS + LEASE_GRACE_MS

/** How often a transition puts again after a conflict whose R2 state it did not adopt. */
const PUT_ATTEMPTS = 3

/** The state R2 holds, and its version: the etag a conditional put names. */
export interface StoredMaintenance {
	readonly state: OpsPublishedState
	readonly version: string
}

/**
 * Since which generation the object has written nothing, as of the published generation `generation`: kept only while
 * it is `read-only`, `closed` or `inspect`.
 */
export interface FrozenRecord {
	readonly generation: number
	readonly since: number
}

/** The object's durable copy of its maintenance state. */
export interface MaintenanceStore {
	/** `null` only for a definite not-found; every other failure throws, and is never read as absence. */
	read(): Promise<StoredMaintenance | null>
	/** Puts `state` if R2 still holds `version` (`null`: holds nothing); the new version, or `null` when the condition failed. */
	put(state: OpsPublishedState, version: string | null): Promise<string | null>
	/** The frozen record, `null` when none is stored. A store without these keeps the record in memory only. */
	readFrozen?(): Promise<FrozenRecord | null>
	putFrozen?(record: FrozenRecord): Promise<void>
}

/** `__fabrika/ops/<object>.json` in the environment's bucket (`bucket`, an R2 binding). */
export function r2MaintenanceStore(bucket: unknown, object: string): MaintenanceStore {
	const key = OPS_STATE_KEY(object)
	// Beside the state, never in it: an older release parses the state strictly and must still load it.
	const frozenKey = `${key.slice(0, -'.json'.length)}.frozen.json`
	const call = (name: string): (...args: unknown[]) => unknown => {
		const found = method(bucket, name)
		if (found === null) {
			throw new Error(`the FABRIKA_FILES binding has no ${name}; the maintenance state lives in the environment's bucket`)
		}
		return found
	}
	return {
		async read() {
			const answer: unknown = await call('get')(key)
			if (answer === null) {
				return null
			}
			const version = typeof answer === 'object' ? Reflect.get(answer, 'etag') : undefined
			const text = method(answer, 'text')
			if (typeof version !== 'string' || version === '' || text === null) {
				throw new Error('R2 answered the maintenance state without its etag or body')
			}
			const body: unknown = await text()
			const state = typeof body === 'string' ? parseStoredState(body) : null
			if (state === null) {
				throw new Error('the maintenance state in R2 does not parse')
			}
			return { state, version }
		},
		async put(state, version) {
			const onlyIf = version === null ? { etagDoesNotMatch: '*' } : { etagMatches: version }
			const answer: unknown = await call('put')(key, JSON.stringify(state), { httpMetadata: { contentType: 'application/json' }, onlyIf })
			if (answer === null) {
				return null
			}
			const etag = typeof answer === 'object' ? Reflect.get(answer, 'etag') : undefined
			if (typeof etag !== 'string' || etag === '') {
				throw new Error('R2 answered the maintenance state put without its etag')
			}
			return etag
		},
		async readFrozen() {
			const answer: unknown = await call('get')(frozenKey)
			if (answer === null) {
				return null
			}
			const text = method(answer, 'text')
			const body: unknown = text === null ? null : await text()
			const record = typeof body === 'string' ? parseFrozenRecord(body) : null
			if (record === null) {
				throw new Error('the frozen record in R2 does not parse')
			}
			return record
		},
		async putFrozen(record) {
			await call('put')(frozenKey, JSON.stringify(record), { httpMetadata: { contentType: 'application/json' } })
		},
	}
}

/** Exactly two positive generations, the stretch's start not after the generation it was recorded at. */
function parseFrozenRecord(text: string): FrozenRecord | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 2) {
		return null
	}
	const generation: unknown = Reflect.get(value, 'generation')
	const since: unknown = Reflect.get(value, 'since')
	return positive(generation) && positive(since) && since <= generation ? { generation, since } : null
}

function positive(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** The stored record, parsed strictly: exactly a positive generation and a mode. */
function parseStoredState(text: string): OpsPublishedState | null {
	let value: unknown
	try {
		value = JSON.parse(text)
	} catch {
		return null
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 2) {
		return null
	}
	const generation: unknown = Reflect.get(value, 'generation')
	const mode = OPS_MODES.find((candidate) => candidate === Reflect.get(value, 'mode'))
	if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0 || mode === undefined) {
		return null
	}
	return { generation, mode }
}

/** What each mode admits of ordinary invocations; ops requests are admitted in every mode. */
const ADMITTED: Readonly<Record<OpsMode, ReadonlySet<InvocationKind>>> = {
	open: new Set(['read', 'write', 'webhook', 'kick', 'job', 'framework-job']),
	'read-only': new Set(['read']),
	closed: new Set(),
	inspect: new Set(),
}

/** The kinds a drain aborts at once; a request gets the handler's share of the bound and is fenced. */
const STOPPABLE: ReadonlySet<InvocationKind> = new Set(['kick', 'job', 'framework-job'])

export type TransitionResult =
	| { readonly kind: 'acknowledged'; readonly ack: OpsStateAck }
	/** The 409: what R2 holds as far as the object knows, `null` before the first publication. */
	| { readonly kind: 'stale'; readonly published: OpsPublishedState | null }
	/** R2 could not be read or written: the call fails and Control retries. */
	| { readonly kind: 'failed' }
	/** The caller's `frozen` held the object in `inspect`: nothing changed. */
	| { readonly kind: 'frozen' }

export type MigrateResult<T> = { readonly kind: 'migrated'; readonly value: T } | {
	readonly kind: 'stale'
	readonly published: OpsPublishedState | null
}

/** What a step run in the barrier's turn answers, and what keeps the turn past the answer (`null`: nothing). */
export interface TurnStep<T> {
	readonly value: T
	readonly holdUntil: Promise<void> | null
}

export type StepResult<T> = { readonly kind: 'ran'; readonly value: T } | {
	readonly kind: 'stale'
	readonly published: OpsPublishedState | null
}

/** One unit the drain waits for: an admitted invocation, or work it handed on that outlives it. */
interface Unit {
	readonly kind: InvocationKind
}

export interface BarrierOptions {
	/** The drain's bound; `DRAIN_BOUND_MS` by default. */
	readonly drainBoundMs?: number
}

export class MaintenanceBarrier {
	#mode: OpsMode
	#generation: number | null
	/** What R2 holds as far as this instance knows: as last read, written or adopted. */
	#stored: OpsPublishedState | null
	#version: string | null
	/** The generation since which the object has written nothing, while it is published in a mode that writes nothing. */
	#frozenSince: number | null
	readonly #store: MaintenanceStore
	readonly #drainBoundMs: number
	/** One transition at a time: each waits for the one before it. */
	#turn: Promise<void> = Promise.resolve()
	readonly #units = new Set<Unit>()
	readonly #stops = new Map<AbortController, InvocationKind>()
	#settled: (() => void)[] = []

	private constructor(store: MaintenanceStore, stored: StoredMaintenance | null, frozen: FrozenRecord | null, options: BarrierOptions) {
		this.#store = store
		this.#stored = stored?.state ?? null
		this.#version = stored?.version ?? null
		this.#mode = stored?.state.mode ?? 'open'
		this.#generation = stored?.state.generation ?? null
		this.#frozenSince = stored === null ? null : frozenOnLoad(stored.state, frozen)
		this.#drainBoundMs = options.drainBoundMs ?? DRAIN_BOUND_MS
	}

	/** The cold start: an absent state is `open`; a failed read rejects, and the caller retries on its next request. */
	static async load(store: MaintenanceStore, options: BarrierOptions = {}): Promise<MaintenanceBarrier> {
		const stored = await store.read()
		const frozen = stored === null || stored.state.mode === 'open' ? null : ((await store.readFrozen?.()) ?? null)
		return new MaintenanceBarrier(store, stored, frozen, options)
	}

	get mode(): OpsMode {
		return this.#mode
	}

	view(): OpsMaintenance {
		return { mode: this.#mode, generation: this.#generation, published: this.#isPublished() }
	}

	/** What R2 holds as far as this instance knows, `null` before the first publication: what a stale refusal names. */
	get published(): OpsPublishedState | null {
		return this.#stored
	}

	/**
	 * The generation at which the object entered its current stretch of `read-only`, `closed` and `inspect`, or at which a
	 * data step last wrote within it; `null` outside such a stretch. A consistent dump is one state while it holds.
	 */
	get frozenSince(): number | null {
		return this.#frozenSince
	}

	/**
	 * Called in a data step's turn before the step writes while the object writes nothing else (an import step, a
	 * restore's `arm`): the stretch starts again at the current generation, durably before the write. A failed put rejects.
	 */
	async restrictedWrite(): Promise<void> {
		if (this.#mode === 'open' || this.#generation === null || this.#frozenSince === this.#generation) {
			return
		}
		this.#frozenSince = this.#generation
		await this.#store.putFrozen?.({ generation: this.#generation, since: this.#generation })
	}

	/** The scope of one invocation, admitted now: the generation and mode it captures, which its writes are fenced on. */
	event(): BarrierEvent {
		return new BarrierEvent(this, this.#generation, this.#mode)
	}

	/** Whether a write of an invocation admitted at `generation` in `mode` may commit now. */
	writable(generation: number | null, mode: OpsMode): boolean {
		return mode === 'open' && this.#mode === 'open' && this.#generation === generation
	}

	/** Admits an invocation of `kind` captured at `generation`, or `null` when the mode refuses it or a transition followed. */
	admit(kind: InvocationKind, generation: number | null): InvocationAdmission | null {
		if (!ADMITTED[this.#mode].has(kind) || this.#generation !== generation) {
			return null
		}
		const unit: Unit = { kind }
		const stop = new AbortController()
		this.#units.add(unit)
		this.#stops.set(stop, kind)
		let released = false
		return {
			signal: stop.signal,
			track: (work) => {
				const outliving: Unit = { kind }
				this.#units.add(outliving)
				const done = () => this.#leave(outliving)
				work.then(done, done)
			},
			release: () => {
				if (!released) {
					released = true
					this.#stops.delete(stop)
					this.#leave(unit)
				}
			},
		}
	}

	/**
	 * `POST /__fabrika/ops/state`: the transition of ADR-0069 §3, acknowledged once published and drained. `frozen` is
	 * asked in the turn, after every data step before it: while it holds, no transition leaves `inspect`.
	 */
	transition(requested: OpsPublishedState, frozen: () => boolean = () => false): Promise<TransitionResult> {
		// Exactly the state: what R2 stores and a stale refusal names.
		const request: OpsPublishedState = { generation: requested.generation, mode: requested.mode }
		return this.#inTurn(async () => {
			const current = this.#generation === null ? null : { generation: this.#generation, mode: this.#mode }
			if (opsTransitionRefused(current, request)) {
				return { kind: 'stale', published: this.#stored }
			}
			if (this.#mode === 'inspect' && request.mode !== 'inspect' && frozen()) {
				return { kind: 'frozen' }
			}
			const retry = current !== null && current.generation === request.generation
			if (!retry || !this.#isPublished()) {
				if (rank(request.mode) > rank(this.#mode)) {
					// Before any await: from here no invocation of a class the mode forbids is admitted, and no older write commits.
					this.#mode = request.mode
					this.#generation = request.generation
				}
				const put = await this.#publish(request)
				if (put.kind !== 'published') {
					return put
				}
				await this.#froze(request)
			}
			const stillRunning = await this.#drain()
			return { kind: 'acknowledged', ack: { generation: request.generation, mode: request.mode, stillRunning } }
		})
	}

	/**
	 * `POST /__fabrika/ops/migrate`: `work` runs only under the published generation, in a mode that may migrate, and no
	 * transition runs meanwhile.
	 */
	migrate<T>(generation: number, work: () => Promise<T>): Promise<MigrateResult<T>> {
		return this.#inTurn(async () => {
			if (!this.#isPublished() || this.#generation !== generation || this.#mode === 'inspect') {
				return { kind: 'stale', published: this.#stored }
			}
			return { kind: 'migrated', value: await work() }
		})
	}

	/**
	 * A data step of Control's (ADR-0070): `work` runs in the barrier's turn, only under the published `generation`, with
	 * the mode it is in. No transition runs until `work` settles, nor, when it answers one, until `holdUntil` settles.
	 */
	async step<T>(generation: number, work: (mode: OpsMode) => Promise<TurnStep<T>>): Promise<StepResult<T>> {
		const previous = this.#turn
		const done = Promise.withResolvers<void>()
		this.#turn = done.promise
		let holdUntil: Promise<void> | null = null
		await previous
		try {
			if (!this.#isPublished() || this.#generation !== generation) {
				return { kind: 'stale', published: this.#stored }
			}
			const answered = await work(this.#mode)
			holdUntil = answered.holdUntil
			return { kind: 'ran', value: answered.value }
		} finally {
			if (holdUntil === null) {
				done.resolve()
			} else {
				const release = () => done.resolve()
				holdUntil.then(release, release)
			}
		}
	}

	/**
	 * After `request` is published: `open` ends the stretch, a mode that writes nothing keeps it or starts it at the
	 * request's generation. A failed put of the record is left to the cold start, which then starts the stretch anew.
	 */
	async #froze(request: OpsPublishedState): Promise<void> {
		if (request.mode === 'open') {
			this.#frozenSince = null
			return
		}
		this.#frozenSince ??= request.generation
		try {
			await this.#store.putFrozen?.({ generation: request.generation, since: this.#frozenSince })
		} catch {
			// The stored record then names an older generation or none, which a cold start reads as a stretch starting anew.
		}
	}

	#isPublished(): boolean {
		return this.#stored !== null && this.#stored.generation === this.#generation && this.#stored.mode === this.#mode
	}

	/** Step 3: the conditional put; on success an opening transition switches memory, on a conflict R2 is read again. */
	async #publish(request: OpsPublishedState): Promise<{ readonly kind: 'published' } | Exclude<TransitionResult, { kind: 'acknowledged' }>> {
		for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
			let version: string | null
			try {
				version = await this.#store.put(request, this.#version)
			} catch {
				return { kind: 'failed' }
			}
			if (version !== null) {
				this.#stored = request
				this.#version = version
				this.#mode = request.mode
				this.#generation = request.generation
				return { kind: 'published' }
			}
			let stored: StoredMaintenance | null
			try {
				stored = await this.#store.read()
			} catch {
				return { kind: 'failed' }
			}
			this.#version = stored?.version ?? null
			this.#stored = stored?.state ?? null
			// A higher generation, or the same one in another mode, is published elsewhere: adopted, never overwritten.
			if (stored !== null && opsTransitionRefused(stored.state, request)) {
				this.#mode = stored.state.mode
				this.#generation = stored.state.generation
				// What happened before it is unknown: its stretch starts at it.
				this.#frozenSince = stored.state.mode === 'open' ? null : stored.state.generation
				return { kind: 'stale', published: stored.state }
			}
		}
		return { kind: 'failed' }
	}

	/** Step 4: stops every run the mode forbids, then waits for what it forbids to settle, within the bound. */
	async #drain(): Promise<number> {
		const admitted = ADMITTED[this.#mode]
		for (const [stop, kind] of this.#stops) {
			if (STOPPABLE.has(kind) && !admitted.has(kind)) {
				stop.abort()
			}
		}
		const running = () => [...this.#units].filter((unit) => !admitted.has(unit.kind)).length
		if (running() === 0) {
			return 0
		}
		const bound = Promise.withResolvers<void>()
		const timer = setTimeout(bound.resolve, this.#drainBoundMs)
		try {
			while (running() > 0) {
				const settled = Promise.withResolvers<void>()
				this.#settled.push(settled.resolve)
				if ((await Promise.race([settled.promise.then(() => 'settled' as const), bound.promise.then(() => 'bound' as const)])) === 'bound') {
					break
				}
			}
		} finally {
			clearTimeout(timer)
		}
		return running()
	}

	#leave(unit: Unit): void {
		this.#units.delete(unit)
		const waiting = this.#settled
		this.#settled = []
		for (const resolve of waiting) {
			resolve()
		}
	}

	async #inTurn<T>(work: () => Promise<T>): Promise<T> {
		const previous = this.#turn
		const done = Promise.withResolvers<void>()
		this.#turn = done.promise
		await previous
		try {
			return await work()
		} finally {
			done.resolve()
		}
	}
}

/**
 * The stretch a cold start resumes: none while `open`; the record's when it was written at the published generation;
 * otherwise, conservatively, one starting at the published generation.
 */
function frozenOnLoad(state: OpsPublishedState, frozen: FrozenRecord | null): number | null {
	if (state.mode === 'open') {
		return null
	}
	return frozen !== null && frozen.generation === state.generation && frozen.since <= state.generation ? frozen.since : state.generation
}

/** How restrictive a mode is: `open` least, `inspect` most. */
function rank(mode: OpsMode): number {
	return OPS_MODES.indexOf(mode)
}

/** One invocation's view of the barrier: the gate that admits and counts its work, and its write fence. */
export class BarrierEvent implements InvocationGate {
	readonly #barrier: MaintenanceBarrier
	readonly #generation: number | null
	readonly #mode: OpsMode

	constructor(barrier: MaintenanceBarrier, generation: number | null, mode: OpsMode) {
		this.#barrier = barrier
		this.#generation = generation
		this.#mode = mode
	}

	admit(kind: InvocationKind): InvocationAdmission | null {
		return this.#barrier.admit(kind, this.#generation)
	}

	/** Whether this invocation may commit a write now: still `open`, at the generation it was admitted under. */
	writable(): boolean {
		return this.#barrier.writable(this.#generation, this.#mode)
	}
}
