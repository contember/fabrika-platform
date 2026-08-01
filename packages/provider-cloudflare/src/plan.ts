import type { ProviderDeployPlan, ProviderJobSpec } from '@fabrika/provider-contract'
import { Worker } from 'oblaka-iac'
import type { CloudflareAppConfig } from './authoring'

export type CloudflareStepKind = 'build' | 'provision-resources' | 'migrate' | 'deploy-worker' | 'reconcile-schema' | 'sync-secrets'

export interface CloudflareJobSpec extends ProviderJobSpec {
	readonly kind: CloudflareStepKind
}

export interface CloudflarePlan extends ProviderDeployPlan {
	readonly steps: readonly CloudflareJobSpec[]
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

export interface CloudflarePlanInput {
	readonly appId: string
	readonly env: string
	readonly propustkaUrl?: string
}

export const buildPlan = (
	config: CloudflareAppConfig,
	input: CloudflarePlanInput,
	worker: Worker,
): CloudflarePlan => {
	const steps: CloudflareJobSpec[] = []
	let previous: string | undefined

	const add = (spec: Omit<CloudflareJobSpec, 'dependsOn'>): void => {
		steps.push(previous === undefined ? spec : { ...spec, dependsOn: [previous] })
		previous = spec.id
	}

	if (config.pipeline?.build !== undefined) {
		add({ id: 'build', kind: 'build', description: `Build the Worker (\`${config.pipeline.build}\`)` })
	}

	add({ id: 'provision-resources', kind: 'provision-resources', description: 'Provision Cloudflare resources via oblaka' })

	for (const database of findMigratableDatabases(worker)) {
		add({ id: `migrate:${database.binding}`, kind: 'migrate', description: `Apply D1 migrations for \`${database.binding}\` (${database.name})` })
	}

	add({ id: 'deploy-worker', kind: 'deploy-worker', description: 'Deploy the Worker (`wrangler deploy`)' })

	if (config.schema !== undefined && input.propustkaUrl !== undefined) {
		add({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Reconcile authz schema into IAM' })
	}

	if (config.pipeline?.secrets !== undefined && config.pipeline.secrets.length > 0) {
		add({ id: 'sync-secrets', kind: 'sync-secrets', description: `Sync ${config.pipeline.secrets.length} secret(s) via \`wrangler secret put\`` })
	}

	return { appId: input.appId, env: input.env, steps }
}
