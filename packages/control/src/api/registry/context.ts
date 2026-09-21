import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider } from '@fabrika/provider-contract'
import { type ControlRepositories } from '../../db'
import type { Authorized } from '../../iam'
import { type RepoEvents } from '../../repo-source'
import { type NamespaceProxyChanged } from '../namespaces'

export interface RegistryContext {
	readonly repositories: ControlRepositories
	readonly request: Request
	readonly url: URL
	readonly repoSource: RepoEvents
	readonly provider: ControlProvider
	readonly authorized: Authorized
	readonly catalogChanged?: () => void
	readonly namespaceProxyChanged?: NamespaceProxyChanged
}

export interface RegistryUseCaseContext {
	readonly repositories: ControlRepositories
	readonly repoSource: RepoEvents
	readonly provider: ControlProvider
	readonly auth: AuthContext
	readonly signal: AbortSignal
	readonly catalogChanged?: () => void
	readonly namespaceProxyChanged?: NamespaceProxyChanged
}

export function useCaseContext(c: RegistryContext): RegistryUseCaseContext {
	return {
		repositories: c.repositories,
		repoSource: c.repoSource,
		provider: c.provider,
		auth: c.authorized.auth,
		signal: c.request.signal,
		...(c.catalogChanged === undefined ? {} : { catalogChanged: c.catalogChanged }),
		...(c.namespaceProxyChanged === undefined ? {} : { namespaceProxyChanged: c.namespaceProxyChanged }),
	}
}

export function notifyCatalogChanged(c: RegistryUseCaseContext): void {
	try {
		c.catalogChanged?.()
	} catch {
		console.warn('operations catalog scheduling failed')
	}
}
