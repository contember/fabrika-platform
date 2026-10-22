import type { AppActionDef, AppSchemaDto, AppScopeDef, RoleDto } from '@fabrika/iam-contract'
import { useEffect, useState } from 'react'
import { ApiError } from '../../lib/api'
import { api } from './api'

/**
 * The per-app authz vocabulary a grant / mapping form needs once an app is chosen:
 *  - `roles`: built-in (cross-app) + the app's app/custom roles (`GET /roles?app=…`).
 *  - `scopes`: the app's scope dimensions (`GET /apps/:app/schema`).
 *  - `actions`: the app's action catalog (`GET /apps/:app/schema`).
 *
 * When `app` is null (cross-app), only built-in roles load and there are no scopes /
 * actions (a cross-app grant can't reference an app's scope dimensions or action catalog).
 */
export interface AppVocab {
	roles: RoleDto[]
	scopes: AppScopeDef[]
	actions: AppActionDef[]
}

export type AppVocabState =
	| { status: 'loading' }
	| { status: 'ok'; vocab: AppVocab }
	| { status: 'error'; message: string; retry: () => void }

const EMPTY: AppVocab = { roles: [], scopes: [], actions: [] }

/**
 * Load the vocabulary for `app`. `app` is `undefined` while the admin hasn't chosen yet
 * (no fetch, no roles), `null` for an explicit cross-app choice (built-in roles only), or
 * an app id. Re-fetches whenever `app` changes.
 */
export function useAppVocab(app: string | null | undefined): AppVocabState {
	const [attempt, setAttempt] = useState(0)
	const [loaded, setLoaded] = useState<{ app: typeof app; state: AppVocabState }>({ app, state: { status: 'loading' } })

	useEffect(() => {
		let cancelled = false
		if (app === undefined) {
			return
		}
		setLoaded({ app, state: { status: 'loading' } })

		const rolesP = api.roles.list({ app })
		const schemaP = app === null
			? Promise.resolve<AppSchemaDto | null>(null)
			: api.apps.getSchema({ app })

		Promise.all([rolesP, schemaP])
			.then(([roles, schema]) => {
				if (cancelled) return
				setLoaded({
					app,
					state: {
						status: 'ok',
						vocab: { roles: roles.items, scopes: schema?.scopes ?? [], actions: schema?.actions ?? [] },
					},
				})
			})
			.catch((cause: unknown) => {
				if (cancelled) return
				setLoaded({
					app,
					state: {
						status: 'error',
						message: cause instanceof ApiError ? cause.message : 'Could not load roles and permissions.',
						retry: () => setAttempt((value) => value + 1),
					},
				})
			})

		return () => {
			cancelled = true
		}
	}, [app, attempt])

	if (app === undefined) return { status: 'ok', vocab: EMPTY }
	// Do not render the previous app's choices for one frame before the effect runs.
	return loaded.app === app ? loaded.state : { status: 'loading' }
}
