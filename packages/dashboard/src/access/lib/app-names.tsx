import type { AppDto } from '@fabrika/iam-contract'
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react'
import { api } from './api'

/** IAM application id → the display name its schema declares. An app that declares none is absent. */
export type AppNames = ReadonlyMap<string, string>

const AppNamesContext = createContext<AppNames>(new Map())

export function appNames(apps: readonly AppDto[]): AppNames {
	const names = new Map<string, string>()
	for (const app of apps) {
		if (app.displayName !== null) names.set(app.id, app.displayName)
	}
	return names
}

/** The registered apps' names, read once for the Access plane; until IAM answers, and if it fails, every app shows its id. */
export function useLoadedAppNames(): AppNames {
	const [names, setNames] = useState<AppNames>(new Map())
	useEffect(() => {
		let cancelled = false
		api.apps.list()
			.then((apps) => {
				if (!cancelled) setNames(appNames(apps.items))
			})
			.catch(() => {})
		return () => {
			cancelled = true
		}
	}, [])
	return names
}

export function AppNamesProvider({ names, children }: { names: AppNames; children: ReactNode }) {
	return <AppNamesContext.Provider value={names}>{children}</AppNamesContext.Provider>
}

export function useAppNames(): AppNames {
	return useContext(AppNamesContext)
}

/** A select option has no tooltip, so a named app carries its id in the label. */
export function appOptionLabel(app: AppDto): string {
	return app.displayName === null ? app.id : `${app.displayName} (${app.id})`
}

/** The app's display name, or its id when it declares none. */
export function appText(names: AppNames, app: string): string {
	return names.get(app) ?? app
}

/** The app as a person reads it; a named app keeps its id in the tooltip. */
export function AppName({ app }: { app: string }) {
	const name = useAppNames().get(app)
	return name === undefined ? <>{app}</> : <span title={app}>{name}</span>
}
