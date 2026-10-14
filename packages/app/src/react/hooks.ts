// The data hooks over the typed client: `useQuery`, `useInfiniteQuery`, `useMutation`, `useAction` and
// `useInvalidate`. Each takes a client procedure (`api.deals.get`) as the typed name of the call; the answer comes back
// through the procedure's own output schema, so its type is the contract's.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { z } from 'zod/v4'
import type { Schema } from '../contract/define'
import { type FabrikaError, toFabrikaError } from './errors'
import { parentOf, prefixOf, useFabrika } from './provider'
import type { PagesEntry, QueryEntry } from './store'
import type { InputArgument, InvalidateTarget, PagedProcedure, PageInput, TypedProcedure } from './types'

/** Pass as the input to wait: the query sends nothing until its input is known. */
export const skip: unique symbol = Symbol('fabrika.skip')

export type QueryState<T> =
	& { readonly fetching: boolean; refetch(): Promise<void> }
	& (
		| { readonly status: 'idle'; readonly data: undefined; readonly error: null }
		| { readonly status: 'loading'; readonly data: undefined; readonly error: null }
		| { readonly status: 'success'; readonly data: T; readonly error: null }
		/** `data` keeps the last answer when a refetch failed. */
		| { readonly status: 'error'; readonly data: T | undefined; readonly error: FabrikaError }
	)

const IDLE = Object.freeze({ status: 'idle', data: undefined, error: null, fetching: false, refetch: () => Promise.resolve() } as const)

const NO_ENTRY = { subscribe: () => () => {}, snapshot: null }

/** An answer the cache holds, read back through the output schema; a value it refuses is an error, never a cast. */
function readBack<O extends Schema>(schema: O, value: unknown): { readonly ok: true; readonly data: z.output<O> } | { readonly ok: false } {
	const parsed = z.safeParse(schema, value)
	return parsed.success ? { ok: true, data: parsed.data } : { ok: false }
}

const UNREADABLE: FabrikaError = { kind: 'other', message: 'the cached answer does not match the output schema', status: 0 }

/** Starts the entry's first load once a view shows it, and again after it failed. */
function useLoad(entry: QueryEntry | PagesEntry | null): void {
	useEffect(() => {
		if (entry !== null && entry.snapshot.status !== 'success' && !entry.snapshot.fetching) void entry.load()
	}, [entry])
}

/**
 * The answer of a query, cached by procedure and input: every view of one call shares one request, and a mutation
 * that invalidates it refetches it. Pass `skip` as the input to wait for a value the input needs.
 */
export function useQuery<O extends Schema>(
	procedure: TypedProcedure<Record<never, never> | undefined, O>,
	input?: typeof skip,
): QueryState<z.output<O>>
export function useQuery<I, O extends Schema>(procedure: TypedProcedure<I, O>, input: I | typeof skip): QueryState<z.output<O>>
export function useQuery<I, O extends Schema>(procedure: TypedProcedure<I, O>, input?: I | typeof skip): QueryState<z.output<O>> {
	const fabrika = useFabrika('useQuery')
	const target = useMemo(() => fabrika.target(procedure, 'useQuery'), [fabrika, procedure])
	if (target.node.procedure?.type === 'mutation') throw new Error(`useQuery: '${target.id}' is a mutation; use useMutation`)
	const waiting = input === skip
	const key = waiting ? null : JSON.stringify(input ?? null)
	// The entry follows the input's value, not its identity: a fresh object literal each render is the same query.
	const entry = useMemo(() => (waiting ? null : fabrika.store.query(target, input ?? undefined)), [fabrika, target, key])
	const source = entry ?? NO_ENTRY
	const snapshot = useSyncExternalStore((listener) => source.subscribe(listener), () => source.snapshot, () => source.snapshot)
	useLoad(entry)
	const refetch = useCallback(() => entry?.load() ?? Promise.resolve(), [entry])
	return useMemo((): QueryState<z.output<O>> => {
		if (snapshot === null) return IDLE
		const fetching = snapshot.fetching
		if (snapshot.status === 'loading') return { status: 'loading', data: undefined, error: null, fetching, refetch }
		const read = snapshot.data === undefined ? null : readBack(procedure.output, snapshot.data)
		if (read !== null && !read.ok) return { status: 'error', data: undefined, error: UNREADABLE, fetching, refetch }
		const data = read?.data
		if (snapshot.status === 'error' && snapshot.error !== null) return { status: 'error', data, error: snapshot.error, fetching, refetch }
		return data === undefined
			? { status: 'loading', data: undefined, error: null, fetching, refetch }
			: { status: 'success', data, error: null, fetching, refetch }
	}, [snapshot, procedure, refetch])
}

export interface InfiniteQueryOptions {
	/** How many pages the first load reads: `1` (the default) or every page (`'all'`, for a picker's options). */
	readonly pages?: number | 'all'
}

export interface InfiniteQueryState<Item> {
	readonly status: 'idle' | 'loading' | 'success' | 'error'
	/** Every item of the loaded pages, in order. */
	readonly items: readonly Item[]
	readonly error: FabrikaError | null
	readonly hasMore: boolean
	readonly fetching: boolean
	readonly loadingMore: boolean
	loadMore(): Promise<void>
	refetch(): Promise<void>
}

/**
 * A cursor list (`{ items, next }`, input `after`): the loaded pages as one list and `loadMore` for the next page. A
 * refetch reads as many pages as are loaded again, from the first cursor.
 */
export function useInfiniteQuery<I extends { readonly after?: string } | undefined, Item>(
	procedure: PagedProcedure<I, Item>,
	input: PageInput<I> | typeof skip,
	options: InfiniteQueryOptions = {},
): InfiniteQueryState<Item> {
	const fabrika = useFabrika('useInfiniteQuery')
	const target = useMemo(() => fabrika.target(procedure, 'useInfiniteQuery'), [fabrika, procedure])
	const waiting = input === skip
	const pages = options.pages === 'all' ? Number.POSITIVE_INFINITY : Math.max(1, options.pages ?? 1)
	const key = waiting ? null : JSON.stringify(input ?? null)
	const entry = useMemo(() => (waiting ? null : fabrika.store.pages(target, input ?? undefined, pages)), [fabrika, target, key, pages])
	const source = entry ?? NO_ENTRY
	const snapshot = useSyncExternalStore((listener) => source.subscribe(listener), () => source.snapshot, () => source.snapshot)
	useLoad(entry)
	const loadMore = useCallback(() => entry?.loadMore() ?? Promise.resolve(), [entry])
	const refetch = useCallback(() => entry?.load() ?? Promise.resolve(), [entry])
	return useMemo((): InfiniteQueryState<Item> => {
		if (snapshot === null) return { status: 'idle', items: [], error: null, hasMore: false, fetching: false, loadingMore: false, loadMore, refetch }
		const read = readBack(procedure.output, { items: snapshot.items, next: snapshot.next })
		return {
			status: read.ok ? snapshot.status : 'error',
			items: read.ok ? read.data.items : [],
			error: read.ok ? snapshot.error : UNREADABLE,
			hasMore: snapshot.next !== null,
			fetching: snapshot.fetching,
			loadingMore: snapshot.loadingMore,
			loadMore,
			refetch,
		}
	}, [snapshot, procedure, loadMore, refetch])
}

export type MutationResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly error: FabrikaError }

export interface MutationState<I, T> {
	readonly status: 'idle' | 'pending' | 'success' | 'error'
	readonly pending: boolean
	readonly data: T | undefined
	readonly error: FabrikaError | null
	/** Runs the call; never throws: a refusal is `{ ok: false, error }` and the state's `error`. */
	mutate(input: I): Promise<MutationResult<T>>
	reset(): void
}

export interface MutationOptions<T> {
	/**
	 * What to refetch after a success: procedures and groups of the client. Without it the procedure's own group
	 * (`api.deals` for `api.deals.create`); `[]` refetches nothing.
	 */
	readonly invalidates?: readonly InvalidateTarget[]
	readonly onSuccess?: (data: T) => void
}

type RunState<T> = Pick<MutationState<unknown, T>, 'status' | 'data' | 'error'>

/** The state machine of a call a person starts: pending, then its answer or its refusal, then what it invalidates. */
function useRun<I, T>(run: (input: I) => Promise<T>, after: () => Promise<void>, onSuccess?: (data: T) => void): MutationState<I, T> {
	const [state, setState] = useState<RunState<T>>({ status: 'idle', data: undefined, error: null })
	const mutate = useCallback(async (input: I): Promise<MutationResult<T>> => {
		setState({ status: 'pending', data: undefined, error: null })
		let data: T
		try {
			data = await run(input)
		} catch (refusal) {
			const error = toFabrikaError(refusal)
			setState({ status: 'error', data: undefined, error })
			return { ok: false, error }
		}
		await after()
		setState({ status: 'success', data, error: null })
		onSuccess?.(data)
		return { ok: true, data }
	}, [run, after, onSuccess])
	const reset = useCallback(() => setState({ status: 'idle', data: undefined, error: null }), [])
	return { ...state, pending: state.status === 'pending', mutate, reset }
}

/**
 * A mutation of the client: `mutate(input)` checks the input with the procedure's schema (a refused input is a
 * `validation` error and sends nothing), calls it, and after a success refetches what `invalidates` names.
 */
export function useMutation<I, O extends Schema>(
	procedure: TypedProcedure<I, O>,
	options: MutationOptions<z.output<O>> = {},
): MutationState<InputArgument<I>, z.output<O>> {
	const fabrika = useFabrika('useMutation')
	const target = useMemo(() => fabrika.target(procedure, 'useMutation'), [fabrika, procedure])
	const run = useCallback(async (input: InputArgument<I>): Promise<z.output<O>> => {
		const read = readBack(procedure.output, await target.run(input ?? undefined))
		if (!read.ok) throw new Error(`'${target.id}' answered a value its output schema refuses`)
		return read.data
	}, [procedure, target])
	const prefixes = useMemo(() => (options.invalidates === undefined ? [parentOf(target.node)] : options.invalidates.map(prefixOf)), [
		target,
		options.invalidates,
	])
	const after = useCallback(() => fabrika.store.invalidate(prefixes), [fabrika, prefixes])
	return useRun(run, after, options.onSuccess)
}

/**
 * A call that is no client procedure yet (a file upload until the client covers file collections), with the same
 * state and error union as a mutation. It refetches only what `invalidates` names.
 */
export function useAction<I, T>(run: (input: I) => Promise<T>, options: MutationOptions<T> = {}): MutationState<I, T> {
	const fabrika = useFabrika('useAction')
	const prefixes = useMemo(() => (options.invalidates ?? []).map(prefixOf), [options.invalidates])
	const after = useCallback(() => fabrika.store.invalidate(prefixes), [fabrika, prefixes])
	return useRun(run, after, options.onSuccess)
}

/** Refetches every shown query under the procedures or groups given, and forgets the cached rest. */
export function useInvalidate(): (...targets: readonly InvalidateTarget[]) => Promise<void> {
	const fabrika = useFabrika('useInvalidate')
	return useCallback((...targets) => fabrika.store.invalidate(targets.map(prefixOf)), [fabrika])
}
