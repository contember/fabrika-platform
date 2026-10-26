import { Worker } from 'oblaka-iac'
import type { CloudflareAppConfig } from './authoring'

export type CloudflareStepKind = 'build' | 'provision-resources' | 'migrate' | 'deploy-worker' | 'reconcile-schema' | 'sync-secrets'

export interface CloudflareStep {
	readonly id: string
	readonly kind: CloudflareStepKind
	readonly description: string
}

export interface MigratableDatabase {
	readonly binding: string
	readonly name: string
}

const migratableDatabaseName = (value: unknown): string | null => {
	if (typeof value !== 'object' || value === null || !('options' in value)) {
		return null
	}
	const { options } = value
	if (typeof options !== 'object' || options === null) {
		return null
	}
	if (!('migrationsDir' in options) || typeof options.migrationsDir !== 'string' || options.migrationsDir === '') {
		return null
	}
	return 'name' in options && typeof options.name === 'string' ? options.name : null
}

export const findMigratableDatabases = (worker: Worker): MigratableDatabase[] => {
	const databases: MigratableDatabase[] = []
	const visit = (current: Worker, prefix: string): void => {
		for (const [binding, value] of Object.entries(current.options.bindings ?? {})) {
			const qualifiedBinding = prefix === '' ? binding : `${prefix}.${binding}`
			const name = migratableDatabaseName(value)
			if (name !== null) {
				databases.push({ binding: qualifiedBinding, name })
			}
			if (value instanceof Worker) {
				visit(value, qualifiedBinding)
			}
		}
	}
	visit(worker, '')
	return databases
}

/**
 * Every resource name fabrika's own components declare (control, IAM, Operations, the runner and the
 * installation's oblaka state). oblaka ADOPTS an existing `${env}-${name}`, so a checkout that names
 * one would take over the platform's own Worker, database or bucket.
 */
export const PLATFORM_RESOURCE_NAMES: ReadonlySet<string> = new Set([
	'vozka',
	'vozka-proxy',
	'vozka-runner',
	'vozka-deploy',
	'vozka-deploy-runner',
	'vozka-mail',
	'vozka-run-logs',
	'propustka',
	'propustka-worker',
	'propustka-state',
	'operations',
	'operations-proxy',
	'operations-payloads',
	'operations-ingest',
	'operations-ingest-dlq',
])

const ENTRY_BUILD = '`fabrika app build --provider=cloudflare`'

/** `regeneratesEntry`: the release pins the generated entry, so the build step always runs, after `pipeline.build`. */
export const buildPlan = (config: CloudflareAppConfig, worker: Worker, regeneratesEntry: boolean): readonly CloudflareStep[] => {
	const steps: CloudflareStep[] = []

	const build = config.pipeline?.build
	if (build !== undefined && regeneratesEntry) {
		steps.push({ id: 'build', kind: 'build', description: `Build the Worker (\`${build}\`), then regenerate its entry (${ENTRY_BUILD})` })
	} else if (build !== undefined) {
		steps.push({ id: 'build', kind: 'build', description: `Build the Worker (\`${build}\`)` })
	} else if (regeneratesEntry) {
		steps.push({ id: 'build', kind: 'build', description: `Regenerate the Worker's entry (${ENTRY_BUILD})` })
	}

	steps.push({ id: 'provision-resources', kind: 'provision-resources', description: 'Provision Cloudflare resources via oblaka' })

	for (const database of findMigratableDatabases(worker)) {
		steps.push({
			id: `migrate:${database.binding}`,
			kind: 'migrate',
			description: `Apply D1 migrations for \`${database.binding}\` (${database.name})`,
		})
	}

	steps.push({ id: 'deploy-worker', kind: 'deploy-worker', description: 'Deploy the Worker (`wrangler deploy`)' })

	if (config.schema !== undefined) {
		steps.push({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Report the authz schema for the control plane to reconcile into IAM' })
	}

	if (config.pipeline?.secrets !== undefined && config.pipeline.secrets.length > 0) {
		steps.push({
			id: 'sync-secrets',
			kind: 'sync-secrets',
			description: `Sync ${config.pipeline.secrets.length} secret(s) via \`wrangler secret put\``,
		})
	}

	return steps
}
