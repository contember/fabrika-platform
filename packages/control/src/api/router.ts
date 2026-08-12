// The `/api/*` REST adapter maps method + path to typed use cases. Resource-independent ACL checks run
// here. Run/deploy use cases resolve their app/environment coordinates first so denied callers receive
// the same hidden 404 as an unknown resource.
//
// ACL: each route names its action (src/actions.ts) and, where it operates on a specific app/env, the
// scope (app / environment). Authentication has already resolved `deps.auth`; mutations audit through
// that same context.

import type { AuthContext } from '@fabrika/auth'
import type { ControlProvider } from '@fabrika/provider-contract'
import { ACTIONS } from '../actions'
import type { ControlRepositories, RunRow } from '../db'
import { error } from '../http'
import { appScope, authorize } from '../iam'
import type { RepoEvents } from '../repo-source'
import type { Vault } from '../vault'
import { adoptNamespace, createNamespace, getNamespace, listNamespaces, type NamespaceContext, planNamespace, reconcileNamespace } from './namespaces'
import {
	createApp,
	deleteApp,
	deleteAppEnv,
	deleteAppSecret,
	deleteAppVar,
	getApp,
	listAppEnvs,
	listApps,
	listAppSecrets,
	listAppVars,
	putAppEnv,
	putAppSecret,
	putAppVar,
	registerApp,
	type RegistryContext,
	updateApp,
} from './registry'
import { cancelRun, type DeployQueue, getRun, getRunLog, listRuns, type LogReader, type RunsContext, tailRunLog, triggerDeploy } from './runs'
import { deleteAppSecretValue, rotateAppSecretValue, setAppSecretValue, type VaultContext } from './vault'

/**
 * Everything the router needs (the Worker assembles this from its bindings). `vault` is a FACTORY
 * (async, may need to import the master key) so it's only built when a vault route is hit, and a
 * missing/invalid `FABRIKA_CONTROL_VAULT_KEY` surfaces as a clean 500 on those routes alone — every non-vault
 * route works without a vault configured.
 */
export interface ApiDeps {
	repositories: ControlRepositories
	/** The context resolved once by the application auth middleware. */
	auth: AuthContext
	queue: DeployQueue
	logs: LogReader
	/** Used by the registry handlers to auto-detect an app's GitHub installation id at onboarding. */
	repoSource: RepoEvents
	/** The installation's one statically composed provider. */
	provider: ControlProvider
	/** Cancel a run: destroy its container (off-local) + mark failed + free the deploy lock. */
	cancelRun: (run: RunRow) => Promise<void>
	vault?: () => Promise<Vault>
	/** Schedule a non-blocking full Operations catalog projection after registry mutations. */
	catalogChanged?: () => void
}

/**
 * Handle any `/api/*` request (except the webhook). Returns the handler's Response, or a 401/403 from
 * the ACL guard, 404/405 for unknown routes/methods, 500 on an unexpected throw (never leaks internals).
 */
export async function handleApi(request: Request, deps: ApiDeps): Promise<Response> {
	const url = new URL(request.url)
	try {
		const response = await dispatch(request, url, deps)
		return response
	} catch (err) {
		console.error('api request failed', err instanceof Error ? err.message : 'unknown error')
		return error(500, 'internal error')
	}
}

async function dispatch(request: Request, url: URL, deps: ApiDeps): Promise<Response> {
	const method = request.method
	// /api/<resource>/<id>/<sub>/<subId>/<subSub>
	const segments = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean)
	const [resource, id, sub, subId, subSub] = segments

	const registryCtx = (authorized: Awaited<ReturnType<typeof authorize>>): RegistryContext | Response => {
		if (!authorized.ok) {
			return authorized.response
		}
		return {
			repositories: deps.repositories,
			repoSource: deps.repoSource,
			provider: deps.provider,
			request,
			url,
			authorized,
			...(deps.catalogChanged === undefined ? {} : { catalogChanged: deps.catalogChanged }),
		}
	}
	const runsCtx = (): RunsContext => ({
		repositories: deps.repositories,
		queue: deps.queue,
		logs: deps.logs,
		cancel: deps.cancelRun,
		request,
		url,
		auth: deps.auth,
	})
	const namespaceCtx = (authorized: Awaited<ReturnType<typeof authorize>>): NamespaceContext | Response => {
		if (!authorized.ok) {
			return authorized.response
		}
		return { repositories: deps.repositories, provider: deps.provider, request, authorized }
	}
	// Build a vault context (constructs the Vault via the factory; a missing/invalid master key is a
	// clean 500 here, isolated to vault routes). Returns the error/Response otherwise.
	const vaultCtx = (authorized: Awaited<ReturnType<typeof authorize>>): VaultContext | Response => {
		if (!authorized.ok) {
			return authorized.response
		}
		return {
			repositories: deps.repositories,
			request,
			url,
			authorized,
			provider: deps.provider,
			...(deps.vault !== undefined ? { vault: deps.vault } : {}),
		}
	}

	switch (resource) {
		// ── Onboarding (app.manage, global) ────────────────────────────────────
		case 'register-app': {
			if (method !== 'POST') return methodNotAllowed()
			const a = authorize(deps.auth, ACTIONS.APP_MANAGE)
			const c = registryCtx(a)
			return c instanceof Response ? c : registerApp(c)
		}

		// ── Apps + nested envs/secrets (app.manage / secret.manage, app-scoped) ─
		case 'apps': {
			if (id === undefined) {
				if (method === 'GET') {
					// Listing apps needs app.manage globally (no specific app to scope to).
					const a = authorize(deps.auth, ACTIONS.APP_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : listApps(c)
				}
				if (method === 'POST') {
					const a = authorize(deps.auth, ACTIONS.APP_MANAGE)
					const c = registryCtx(a)
					return c instanceof Response ? c : createApp(c)
				}
				return methodNotAllowed()
			}

			// Nested: /api/apps/:id/envs[/:env] and /api/apps/:id/secrets[/:name]
			if (sub === 'envs') {
				const a = authorize(deps.auth, ACTIONS.APP_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppEnvs(c, id)
					return methodNotAllowed()
				}
				if (method === 'PUT') return putAppEnv(c, id, subId)
				if (method === 'DELETE') return deleteAppEnv(c, id, subId)
				return methodNotAllowed()
			}
			if (sub === 'secrets') {
				// /api/apps/:id/secrets/:name/value — the encrypted secret VALUE (vault, write-only).
				// PUT = set (re-encrypts under a fresh entry), PATCH = rotate in place, DELETE = drop entry.
				if (subId !== undefined && subSub === 'value') {
					const a = authorize(deps.auth, ACTIONS.SECRET_MANAGE, appScope(id))
					const c = vaultCtx(a)
					if (c instanceof Response) return c
					if (method === 'PUT') return setAppSecretValue(c, id, subId)
					if (method === 'PATCH') return rotateAppSecretValue(c, id, subId)
					if (method === 'DELETE') return deleteAppSecretValue(c, id, subId)
					return methodNotAllowed()
				}
				// /api/apps/:id/secrets and /api/apps/:id/secrets/:name — the reference rows (registry).
				const a = authorize(deps.auth, ACTIONS.SECRET_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppSecrets(c, id)
					if (method === 'PUT') return putAppSecret(c, id)
					return methodNotAllowed()
				}
				if (method === 'DELETE') return deleteAppSecret(c, id, subId)
				return methodNotAllowed()
			}
			// /api/apps/:id/vars[/:name] — NON-secret per-app-env deploy config (plaintext, readable).
			// app.manage (not secret.manage): vars are app config like app_envs, not vault secrets.
			if (sub === 'vars') {
				const a = authorize(deps.auth, ACTIONS.APP_MANAGE, appScope(id))
				const c = registryCtx(a)
				if (c instanceof Response) return c
				if (subId === undefined) {
					if (method === 'GET') return listAppVars(c, id)
					if (method === 'PUT') return putAppVar(c, id)
					return methodNotAllowed()
				}
				if (method === 'DELETE') return deleteAppVar(c, id, subId)
				return methodNotAllowed()
			}

			// /api/apps/:id itself (app.manage, app-scoped)
			const a = authorize(deps.auth, ACTIONS.APP_MANAGE, appScope(id))
			const c = registryCtx(a)
			if (c instanceof Response) return c
			if (method === 'GET') return getApp(c, id)
			if (method === 'PUT' || method === 'PATCH') return updateApp(c, id)
			if (method === 'DELETE') return deleteApp(c, id)
			return methodNotAllowed()
		}

		// ── Deployment namespaces (namespace.manage, global) ───────────────────
		case 'namespaces': {
			const a = authorize(deps.auth, ACTIONS.NAMESPACE_MANAGE)
			const c = namespaceCtx(a)
			if (c instanceof Response) return c
			if (id === undefined) {
				if (method === 'GET') return listNamespaces(c)
				if (method === 'POST') return createNamespace(c)
				return methodNotAllowed()
			}
			if (id === 'plan' && sub === undefined) {
				return method === 'POST' ? planNamespace(c) : methodNotAllowed()
			}
			if (sub === undefined) {
				return method === 'GET' ? getNamespace(c, id) : methodNotAllowed()
			}
			if (sub === 'adopt') {
				return method === 'POST' ? adoptNamespace(c, id) : methodNotAllowed()
			}
			if (sub === 'reconcile') {
				return method === 'POST' ? reconcileNamespace(c, id) : methodNotAllowed()
			}
			return error(404, 'not found')
		}

		// ── Runs (deploy.read to read; deploy.trigger to deploy) ────────────────
		case 'runs': {
			if (id === undefined) {
				if (method === 'GET') {
					return listRuns(runsCtx())
				}
				return methodNotAllowed()
			}
			// /api/runs/:id/cancel — MUTATION (deploy.trigger), not a read. Cancel a pending/running run.
			if (sub === 'cancel') {
				if (method !== 'POST') return methodNotAllowed()
				return cancelRun(runsCtx(), id)
			}
			const c = runsCtx()
			if (sub === undefined) {
				return method === 'GET' ? getRun(c, id) : methodNotAllowed()
			}
			if (sub === 'log') {
				return method === 'GET' ? getRunLog(c, id) : methodNotAllowed()
			}
			if (sub === 'tail') {
				return method === 'GET' ? tailRunLog(c, id) : methodNotAllowed()
			}
			return error(404, 'not found')
		}

		// ── Manual trigger (deploy.trigger, app+env scoped) ─────────────────────
		case 'deploy': {
			if (method !== 'POST') return methodNotAllowed()
			return triggerDeploy(runsCtx())
		}

		default:
			return error(404, 'not found')
	}
}

function methodNotAllowed(): Response {
	return error(405, 'method not allowed')
}
