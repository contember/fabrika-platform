import type { AppDto, IamAdministrationScope } from '@fabrika/iam-contract'
import { createContext, type ReactNode, useContext } from 'react'

const AdministrationContext = createContext<IamAdministrationScope>({ kind: 'users', apps: [] })

/** What the caller administers, read once from IAM's `me` by the Access layout. */
export function AdministrationProvider({ administration, children }: { administration: IamAdministrationScope; children: ReactNode }) {
	return <AdministrationContext.Provider value={administration}>{children}</AdministrationContext.Provider>
}

export function useAdministration(): IamAdministrationScope {
	return useContext(AdministrationContext)
}

/**
 * The applications a grant form offers (ADR-0058): every app, and the cross-app option, to an installation admin; to a
 * user administrator the applications in its scope, never the installation's own apps. IAM refuses anything else.
 */
export function grantTargets(apps: readonly AppDto[], administration: IamAdministrationScope): { apps: AppDto[]; crossApp: boolean } {
	if (administration.kind === 'installation') return { apps: [...apps], crossApp: true }
	const { apps: scope } = administration
	return { apps: apps.filter((app) => !app.installation && (scope === null || scope.includes(app.id))), crossApp: false }
}
