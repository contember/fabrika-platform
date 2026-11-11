// What every screen shares: a refusal in plain Czech, a toast for an action's outcome, and a list's table state.

import type { FabrikaError, InfiniteQueryState, MutationResult } from '@fabrika/app/react'
import { type FormErrorLike, type LoadMore, type TableStatus, useToast } from '@fabrika/ui'

/** What a person reads for a refusal: the platform's answer, made plain. */
export function describe(error: FabrikaError): FormErrorLike {
	switch (error.kind) {
		case 'forbidden':
			return { message: 'Na tohle tvoje role nemá oprávnění. Platforma požadavek odmítla dřív, než se dostal k datům.' }
		case 'not-found':
			return { message: 'Záznam neexistuje, nebo k němu nemáš přístup.' }
		case 'conflict':
			return { message: `Mezitím to někdo změnil (${error.message}). Načti stránku a zkus to znovu.` }
		case 'unauthenticated':
			return { message: 'Přihlášení vypršelo. Přihlas se znovu.' }
		case 'validation':
			return { message: error.message, fields: error.fields }
		case 'other':
			return { message: error.status === 0 ? error.message : `Aplikace neodpověděla (${error.status}).` }
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
		onRetry: () => void list.retry(),
		loadMore: {
			hasMore: list.hasMore,
			loading: list.loadingMore,
			onLoadMore: () => void list.loadMore(),
		},
	}
}
