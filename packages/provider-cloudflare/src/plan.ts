import { Worker } from 'oblaka-iac'
import type { CloudflareAppConfig } from './authoring'

export type CloudflareStepKind = 'build' | 'check' | 'provision-resources' | 'migrate' | 'deploy-worker' | 'reconcile-schema' | 'sync-secrets'

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

const ENTRY_BUILD = '`fabrika app build --provider=cloudflare`'

/**
 * `checks`: an application deploy Control approved, which the check step checks before any resource is touched; null for
 * a local or a platform deploy. With `regeneratesEntry` the release pins the generated entry, which that step regenerates
 * after the tests.
 */
export const buildPlan = (
	config: CloudflareAppConfig,
	worker: Worker,
	checks: { readonly regeneratesEntry: boolean } | null,
): readonly CloudflareStep[] => {
	const steps: CloudflareStep[] = []

	const build = config.pipeline?.build
	if (build !== undefined) {
		steps.push({ id: 'build', kind: 'build', description: `Build the Worker (\`${build}\`)` })
	}

	if (checks !== null) {
		steps.push({
			id: 'check',
			kind: 'check',
			description: checks.regeneratesEntry
				? `Check the application: its tests, then a frozen install, its entry (${ENTRY_BUILD}), \`tsc\`, \`fabrika-check\` and its schema`
				: 'Check the application: its tests, then `fabrika-check`',
		})
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
