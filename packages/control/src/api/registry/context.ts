import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider } from '@fabrika/provider-contract'
import { type ControlRepositories } from '../../db'
import { type RepoEvents } from '../../repo-source'
import { type NamespaceProxyChanged } from '../namespaces'

export interface RegistryUseCaseContext {
	readonly repositories: ControlRepositories
	readonly repoSource: RepoEvents
	readonly provider: ControlProvider
	readonly auth: AuthContext
	readonly signal: AbortSignal
	readonly catalogChanged?: () => void
	readonly namespaceProxyChanged?: NamespaceProxyChanged
}

export function notifyCatalogChanged(c: RegistryUseCaseContext): void {
	try {
		c.catalogChanged?.()
	} catch {
		console.warn('operations catalog scheduling failed')
	}
}
