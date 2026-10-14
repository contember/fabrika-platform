// What every screen shares: a query's loading and error states, the refusal a form shows, and the lists the pickers
// read in full.

import { type FabrikaError, type InfiniteQueryState, type MutationResult, type QueryState, useInfiniteQuery } from '@fabrika/app/react'
import { ErrorState, type FormErrorLike, LoadingState, type LoadMore, type TableStatus, useToast } from '@fabrika/ui'
import type { ReactNode } from 'react'
import { api, type Company } from '../api'

/** What a person reads for a refusal: the proxy's and the application's own words, made plain where they are terse. */
export function describe(error: FabrikaError): FormErrorLike {
	switch (error.kind) {
		case 'forbidden':
			return { message: 'Your role in this org does not allow this.' }
		case 'not-found':
			return { message: 'It is gone, or it is not in an org of yours.' }
		case 'conflict':
			return { message: `Someone changed it meanwhile (${error.message}). Close this and try again on the current version.` }
		case 'unauthenticated':
			return { message: 'Your session ended. Sign in again.' }
		case 'validation':
			return { message: error.message, fields: error.fields }
		case 'other':
			return { message: error.status === 0 ? error.message : `The CRM could not answer (${error.status}).` }
	}
}

/** The children for a query's answer; its loading and error states otherwise. */
export function Loaded<T>({ query, children }: { readonly query: QueryState<T>; readonly children: (data: T) => ReactNode }): ReactNode {
	if (query.status === 'success') return children(query.data)
	if (query.status === 'error' && query.data !== undefined) return children(query.data)
	if (query.status === 'error') return <ErrorState text={describe(query.error).message} onRetry={() => void query.refetch()} />
	return <LoadingState />
}

/** Every company the person can see: deals and contacts show the name, and the create forms pick from them. */
export function useCompanies(): { readonly companies: readonly Company[]; readonly name: (id: string) => string } {
	const list = useInfiniteQuery(api.companies.list, {}, { pages: 'all' })
	return {
		companies: list.items,
		name: (id) => list.items.find((company) => company.id === id)?.name ?? '…',
	}
}

/** A toast for the outcome of a person's action: what happened, or why it was refused. */
export function useReport(): (outcome: MutationResult<unknown>, success: string) => void {
	const toast = useToast()
	return (outcome, success) =>
		toast.show(outcome.ok ? { tone: 'success', message: success } : { tone: 'danger', message: describe(outcome.error).message })
}

/** A cursor list as a table's state props: its status, its refusal with a retry, and the next page. */
export function tableState(list: InfiniteQueryState<unknown>): {
	readonly status: TableStatus
	readonly error?: string
	readonly onRetry: () => void
	readonly loadMore: LoadMore
} {
	return {
		status: list.status === 'success' ? 'ready' : list.status === 'error' ? 'error' : 'loading',
		...(list.error === null ? {} : { error: describe(list.error).message }),
		onRetry: () => void list.refetch(),
		loadMore: { hasMore: list.hasMore, loading: list.loadingMore, onLoadMore: () => void list.loadMore() },
	}
}
