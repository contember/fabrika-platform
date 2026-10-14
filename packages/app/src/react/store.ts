// The provider's cache, without React: one entry per procedure and input (and one per paged list), each with the
// pages it holds, a snapshot the hooks subscribe to, and a sequence number so a slower, older answer never overwrites
// a newer one. `invalidate` refetches the entries a view shows and drops the others.

import type { FabrikaError } from './errors'

/** A procedure as the store calls it: its id (`<mount>.<path>`) and the call of the provider's client. */
export interface StoreTarget {
	readonly id: string
	readonly run: (input: unknown) => Promise<unknown>
}

export type QueryStatus = 'loading' | 'success' | 'error'

export interface QuerySnapshot {
	readonly status: QueryStatus
	readonly data: unknown
	readonly error: FabrikaError | null
	/** A request of this entry is in flight: the first load, a refetch or the next page. */
	readonly fetching: boolean
}

export interface PagesSnapshot {
	readonly status: QueryStatus
	readonly items: readonly unknown[]
	readonly next: string | null
	readonly error: FabrikaError | null
	readonly fetching: boolean
	readonly loadingMore: boolean
}

/** One page of a cursor list, as every list procedure of the paved road answers it. */
export interface Page {
	readonly items: readonly unknown[]
	readonly next: string | null
}

type Listener = () => void

/** JSON with sorted keys, so two inputs that are the same value are the same key. */
export function stableKey(value: unknown): string {
	return JSON.stringify(value, (_key, field: unknown) => {
		if (typeof field !== 'object' || field === null || Array.isArray(field)) return field
		return Object.fromEntries(Object.entries(field).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
	}) ?? 'null'
}

/** `<mount>.<path>` lies under `prefix` when it is the prefix itself or one of its descendants. */
export function under(id: string, prefix: string): boolean {
	return id === prefix || id.startsWith(`${prefix}.`)
}

abstract class Entry<S> {
	snapshot: S
	protected sequence = 0
	readonly #listeners = new Set<Listener>()

	constructor(readonly target: StoreTarget, readonly input: unknown, initial: S) {
		this.snapshot = initial
	}

	get watched(): boolean {
		return this.#listeners.size > 0
	}

	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener)
		return () => this.#listeners.delete(listener)
	}

	protected publish(snapshot: S): void {
		this.snapshot = snapshot
		for (const listener of [...this.#listeners]) listener()
	}

	abstract load(): Promise<void>
}

export class QueryEntry extends Entry<QuerySnapshot> {
	constructor(target: StoreTarget, input: unknown, private readonly mapError: (error: unknown) => FabrikaError) {
		super(target, input, { status: 'loading', data: undefined, error: null, fetching: false })
	}

	async load(): Promise<void> {
		const sequence = ++this.sequence
		this.publish({ ...this.snapshot, fetching: true })
		try {
			const data = await this.target.run(this.input)
			if (sequence !== this.sequence) return
			this.publish({ status: 'success', data, error: null, fetching: false })
		} catch (error) {
			if (sequence !== this.sequence) return
			this.publish({ ...this.snapshot, status: 'error', error: this.mapError(error), fetching: false })
		}
	}
}

/** `null` when the answer is no page: a hook over a procedure that does not page reports it instead of looping. */
function pageOf(value: unknown): Page | null {
	if (typeof value !== 'object' || value === null) return null
	const items: unknown = Reflect.get(value, 'items')
	const next: unknown = Reflect.get(value, 'next')
	return Array.isArray(items) && (typeof next === 'string' || next === null) ? { items, next } : null
}

const NOT_A_PAGE: FabrikaError = { kind: 'other', message: 'the procedure answered no { items, next } page', status: 0 }

export class PagesEntry extends Entry<PagesSnapshot> {
	/** How many pages the view has asked for; a refetch loads as many again. `Infinity` follows every cursor. */
	#pages: number

	constructor(target: StoreTarget, input: unknown, pages: number, private readonly mapError: (error: unknown) => FabrikaError) {
		super(target, input, { status: 'loading', items: [], next: null, error: null, fetching: false, loadingMore: false })
		this.#pages = pages
	}

	#request(after: string | null): Promise<unknown> {
		const input = typeof this.input === 'object' && this.input !== null ? this.input : {}
		return this.target.run(after === null ? input : { ...input, after })
	}

	/** Loads the first `#pages` pages again, from the first cursor. */
	async load(): Promise<void> {
		const sequence = ++this.sequence
		this.publish({ ...this.snapshot, fetching: true })
		try {
			const items: unknown[] = []
			let next: string | null = null
			let loaded = 0
			do {
				const page = pageOf(await this.#request(next))
				if (sequence !== this.sequence) return
				if (page === null) {
					this.#refuse(NOT_A_PAGE)
					return
				}
				items.push(...page.items)
				next = page.next
				loaded++
			} while (next !== null && loaded < this.#pages)
			this.publish({ status: 'success', items, next, error: null, fetching: false, loadingMore: false })
		} catch (error) {
			if (sequence !== this.sequence) return
			this.#refuse(this.mapError(error))
		}
	}

	#refuse(error: FabrikaError): void {
		this.publish({ ...this.snapshot, status: 'error', error, fetching: false, loadingMore: false })
	}

	/** Appends the next page; nothing while a request is in flight or when the list has no more. */
	async loadMore(): Promise<void> {
		const after = this.snapshot.next
		if (after === null || this.snapshot.fetching) return
		const sequence = ++this.sequence
		this.publish({ ...this.snapshot, fetching: true, loadingMore: true })
		try {
			const page = pageOf(await this.#request(after))
			if (sequence !== this.sequence) return
			if (page === null) {
				this.#refuse(NOT_A_PAGE)
				return
			}
			this.#pages++
			this.publish({
				status: 'success',
				items: [...this.snapshot.items, ...page.items],
				next: page.next,
				error: null,
				fetching: false,
				loadingMore: false,
			})
		} catch (error) {
			if (sequence !== this.sequence) return
			// The loaded rows stay; the next `loadMore` asks for the same cursor again.
			this.publish({ ...this.snapshot, status: 'error', error: this.mapError(error), fetching: false, loadingMore: false })
		}
	}
}

export class QueryStore {
	readonly #entries = new Map<string, QueryEntry | PagesEntry>()

	constructor(private readonly mapError: (error: unknown) => FabrikaError) {}

	query(target: StoreTarget, input: unknown): QueryEntry {
		const key = `query\u0000${target.id}\u0000${stableKey(input)}`
		const found = this.#entries.get(key)
		if (found instanceof QueryEntry) return found
		const entry = new QueryEntry(target, input, this.mapError)
		this.#entries.set(key, entry)
		return entry
	}

	pages(target: StoreTarget, input: unknown, pages: number): PagesEntry {
		const key = `pages\u0000${target.id}\u0000${stableKey(input)}\u0000${pages}`
		const found = this.#entries.get(key)
		if (found instanceof PagesEntry) return found
		const entry = new PagesEntry(target, input, pages, this.mapError)
		this.#entries.set(key, entry)
		return entry
	}

	/** Refetches every entry under one of `prefixes` that a view shows, and forgets the rest, so their next view loads. */
	async invalidate(prefixes: readonly string[]): Promise<void> {
		const loads: Promise<void>[] = []
		for (const [key, entry] of this.#entries) {
			if (!prefixes.some((prefix) => under(entry.target.id, prefix))) continue
			if (entry.watched) loads.push(entry.load())
			else this.#entries.delete(key)
		}
		await Promise.all(loads)
	}
}
