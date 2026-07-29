import type {
	ControlProvider,
	JsonValue,
	ProviderApp,
	ProviderEnvelope,
	ProviderEnvironment,
	ProviderTerminalOutcome,
} from '@fabrika/provider-contract'
import { type AppEnvRow, type AppRow, type Db, type RunRow } from './db'
import type { SecretResolver } from './secret-resolver'

export type RunOutcome = ProviderTerminalOutcome

/** The per-app-env deploy lock seam. */
export interface DeployLockGate {
	acquire(key: string, holder: string): Promise<boolean>
	release(key: string, holder: string): Promise<void>
}

/** Everything the provider-neutral lifecycle needs. */
export interface RunDeps {
	db: Db
	secrets: SecretResolver
	provider: ControlProvider
	lock: DeployLockGate
}

export interface DeployJobMessage {
	runId: string
	dryRun?: boolean
}

const logsKey = (runId: string): string => `runs/${runId}/logs.ndjson`

const isJsonValue = (value: unknown): value is JsonValue => {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return true
	}
	if (Array.isArray(value)) {
		return value.every(isJsonValue)
	}
	if (typeof value !== 'object') {
		return false
	}
	return Object.values(value).every(isJsonValue)
}

/** Parse a persisted provider envelope without trusting database text. */
export const parseProviderEnvelope = (raw: string, label: string): ProviderEnvelope => {
	let value: unknown
	try {
		value = JSON.parse(raw)
	} catch {
		throw new Error(`${label} is not valid JSON`)
	}
	if (
		typeof value !== 'object'
		|| value === null
		|| !('provider' in value && typeof value.provider === 'string' && value.provider !== '')
		|| !('version' in value && typeof value.version === 'number' && Number.isInteger(value.version))
		|| !('payload' in value && isJsonValue(value.payload))
	) {
		throw new Error(`${label} is not a provider envelope`)
	}
	return { provider: value.provider, version: value.version, payload: value.payload }
}

const providerApp = (app: AppRow, run: RunRow): ProviderApp => ({
	id: app.id,
	source: {
		repoUrl: app.repo_url,
		ref: run.ref,
		...(app.worker_dir === null ? {} : { workerDir: app.worker_dir }),
		...(app.build_cmd === null ? {} : { buildCommand: app.build_cmd }),
		...(app.config_path === null ? {} : { configPath: app.config_path }),
		...(app.github_installation_id === null ? {} : { githubInstallationId: app.github_installation_id }),
	},
})

/** Convert the generic database row into the provider contract. */
export const providerEnvironment = (row: AppEnvRow): ProviderEnvironment => ({
	appId: row.app_id,
	env: row.env,
	...(row.domain === null ? {} : { domain: row.domain }),
	target: parseProviderEnvelope(row.provider_target_json, `target for ${row.app_id}/${row.env}`),
	artifact: parseProviderEnvelope(row.provider_artifact_json, `artifact for ${row.app_id}/${row.env}`),
})

const resolveVars = async (db: Db, appId: string, env: string): Promise<Record<string, string>> => {
	const vars: Record<string, string> = {}
	for (const row of await db.getAppVarsForEnv(appId, env)) {
		vars[row.name] = row.value
	}
	return vars
}

const resolveSecrets = async (
	deps: RunDeps,
	appId: string,
	env: string,
): Promise<Record<string, string>> => {
	if (deps.provider.secrets !== undefined) {
		return {}
	}
	const secrets: Record<string, string> = {}
	for (const row of await deps.db.getAppSecretsForEnv(appId, env)) {
		secrets[row.name] = await deps.secrets.resolveSecret(row.value_ref)
	}
	return secrets
}

/**
 * Execute one queued deploy through the statically selected provider.
 *
 * Core owns locking and terminal database transitions. The provider owns source delivery, deploy
 * mechanics, external operation ids, reconciliation, and provider-managed secret semantics.
 */
export async function executeDeploy(
	deps: RunDeps,
	message: DeployJobMessage,
): Promise<{ runId: string; status: 'running' | 'succeeded' | 'failed' | 'skipped' | 'deferred' }> {
	const run = await deps.db.getRun(message.runId)
	if (run === null) {
		return { runId: message.runId, status: 'skipped' }
	}
	if (run.status !== 'pending') {
		return { runId: run.id, status: 'skipped' }
	}

	const lockKey = `${run.app_id}:${run.env}`
	if (!(await deps.lock.acquire(lockKey, run.id))) {
		return { runId: run.id, status: 'deferred' }
	}

	try {
		if (!(await deps.db.markRunStarted(run.id, logsKey(run.id)))) {
			return { runId: run.id, status: 'skipped' }
		}
		const app = await deps.db.getApp(run.app_id)
		const appEnv = await deps.db.getAppEnv(run.app_id, run.env)
		if (app === null || appEnv === null) {
			await deps.db.markRunFinished(run.id, 'failed', null)
			return { runId: run.id, status: 'failed' }
		}
		if (appEnv.provider !== deps.provider.id) {
			throw new Error(
				`configured provider "${deps.provider.id}" cannot deploy ${app.id}/${appEnv.env} owned by "${appEnv.provider}"`,
			)
		}

		const outcome = await deps.provider.deploy({
			runId: run.id,
			app: providerApp(app, run),
			environment: providerEnvironment(appEnv),
			secrets: await resolveSecrets(deps, app.id, appEnv.env),
			vars: await resolveVars(deps.db, app.id, appEnv.env),
			dryRun: message.dryRun === true,
			signal: new AbortController().signal,
			events: {
				log: (line) => console.info(`deploy run ${run.id}: ${line}`),
				externalId: async (externalId) => {
					await deps.db.setRunExternalId(run.id, externalId)
				},
			},
		})
		await deps.db.markRunFinished(run.id, outcome.state, outcome.exitCode ?? null)
		return { runId: run.id, status: outcome.state }
	} catch (error) {
		console.error(`deploy run ${run.id} failed:`, error instanceof Error ? error.message : 'unknown error')
		await deps.db.markRunFinished(run.id, 'failed', null)
		return { runId: run.id, status: 'failed' }
	} finally {
		await deps.lock.release(lockKey, run.id)
	}
}

/** Cancel provider-owned work, mark the run failed, and release its deploy lock. */
export async function cancelDeploy(
	deps: Pick<RunDeps, 'db' | 'provider'> & { lock: Pick<DeployLockGate, 'release'> },
	run: RunRow,
): Promise<void> {
	const appEnv = await deps.db.getAppEnv(run.app_id, run.env)
	if (
		appEnv !== null
		&& appEnv.provider === deps.provider.id
		&& run.external_run_id !== null
		&& deps.provider.cancel !== undefined
	) {
		await deps.provider.cancel({
			runId: run.id,
			externalId: run.external_run_id,
			environment: providerEnvironment(appEnv),
		})
	}
	await deps.db.markRunFinished(run.id, 'failed', null)
	await deps.lock.release(`${run.app_id}:${run.env}`, run.id)
}

/** Map a pushed git ref to the app environment it triggers. */
export async function refToEnv(db: Db, appId: string, ref: string): Promise<AppEnvRow | null> {
	return db.getAppEnvByTriggerRef(appId, ref)
}
