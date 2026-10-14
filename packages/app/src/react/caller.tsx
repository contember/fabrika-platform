// Who the page's person is, from the caller document the SPA mount serves: their label, mailbox and what the token
// grants. A page greets by it and shows or hides a control by it. It is information for the page only and never a
// check: every endpoint decides again, so a hidden button protects nothing.

import { type ReactNode, useMemo, useSyncExternalStore } from 'react'
import type { PageCaller } from '../client/caller'
import { useFabrika } from './provider'

/** A scope value as the token names it: `{ type: 'org', value: 'acme' }`. */
export interface CallerScope {
	readonly type: string
	readonly value: string
}

export interface Caller {
	readonly label: string
	readonly email: string
	/**
	 * Whether the token grants `action`: without `scope`, app-wide or in any scope value; with `scope`, app-wide or in
	 * that value itself. A grant on a container is not seen from a value inside it (the page knows no chain): ask at
	 * the dimension the person holds the role in.
	 */
	can(action: string, scope?: CallerScope): boolean
}

/** The caller of a parsed document; exported for a page that reads the document itself. */
export function callerOf(document: PageCaller): Caller {
	const app = new Set(document.actions.app)
	return Object.freeze({
		label: document.label,
		email: document.email,
		can(action: string, scope?: CallerScope): boolean {
			if (app.has(action)) return true
			return document.actions.scopes.some((held) =>
				held.actions.includes(action) && (scope === undefined || (held.type === scope.type && held.value === scope.value))
			)
		},
	})
}

/** The page's caller, or `null` while the document loads and when it could not be read (a public SPA answers 401). */
export function useCaller(): Caller | null {
	const source = useFabrika('useCaller').caller
	const state = useSyncExternalStore((listener) => source.subscribe(listener), () => source.state, () => source.state)
	return useMemo(() => (state.status === 'ready' ? callerOf(state.caller) : null), [state])
}

export interface CanProps {
	readonly action: string
	readonly scope?: CallerScope
	/** Shown instead, also while the caller document loads; nothing by default. */
	readonly fallback?: ReactNode
	readonly children?: ReactNode
}

/** Renders its children when the caller's token grants `action` (see `Caller.can`). Never the access check. */
export function Can({ action, scope, fallback = null, children }: CanProps): ReactNode {
	const caller = useCaller()
	return caller?.can(action, scope) === true ? children : fallback
}
