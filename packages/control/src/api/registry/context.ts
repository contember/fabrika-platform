import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { ConsoleAdmission } from '../../approval/human'
import { type ControlRepositories } from '../../db'
import type { CommitSource } from '../../github/source/commit-files'
import { type NamespaceProxyChanged } from '../namespaces'

export interface RegistryUseCaseContext {
	readonly repositories: ControlRepositories
	readonly provider: ControlProvider
	readonly auth: AuthContext
	readonly signal: AbortSignal
	readonly catalogChanged?: () => void
	readonly namespaceProxyChanged?: NamespaceProxyChanged
	/** How the call arrived; deleting a protected environment needs a human in the console. Absent refuses it. */
	readonly admission?: ConsoleAdmission
	/** Reads GitHub as a deploy does; `register` probes an anonymous source with it. Absent skips the probe. */
	readonly commits?: CommitSource
}

export function notifyCatalogChanged(c: RegistryUseCaseContext): void {
	try {
		c.catalogChanged?.()
	} catch {
		console.warn('operations catalog scheduling failed')
	}
}
