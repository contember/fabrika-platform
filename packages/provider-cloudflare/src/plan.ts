import type { ProviderDeployPlan, ProviderJobSpec } from '@fabrika/provider-contract'
import { isProxyHost } from '@fabrika/proxy-contract'
import { Container, D1Database, KVNamespace, Queue, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
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

const namedResource = (value: unknown): { readonly kind: string; readonly name: string } | null => {
	if (value instanceof Worker) return { kind: 'Worker', name: value.options.name }
	if (value instanceof D1Database) return { kind: 'D1 database', name: value.options.name }
	if (value instanceof KVNamespace) return { kind: 'KV namespace', name: value.options.name }
	if (value instanceof R2Bucket) return { kind: 'R2 bucket', name: value.options.name }
	if (value instanceof Queue) return { kind: 'queue', name: value.options.name }
	if (value instanceof Container) return { kind: 'container', name: value.options.name }
	return null
}

/**
 * A `ServiceReference` binds `${env}-${name}` without declaring it, so it never reaches `namedResource`
 * — it is how an app would call the control plane or the runner directly. IAM is the one exception:
 * every app binds `propustka-worker` (`proxy.ts`), which is the platform's intended front door.
 */
const serviceReferenceTarget = (value: unknown): string | null => {
	if (!(value instanceof ServiceReference)) return null
	const target = Reflect.get(value, 'serviceName')
	return typeof target === 'string' && target !== '' ? target : '(unreadable)'
}

const routeHostname = (route: unknown): string | null => {
	const pattern = typeof route === 'string' ? route : typeof route === 'object' && route !== null ? Reflect.get(route, 'pattern') : undefined
	if (typeof pattern !== 'string') return null
	const host = pattern.split('/')[0]
	return host === undefined ? null : host.toLowerCase()
}

const applicationChain = (root: Worker): ReadonlySet<Worker> => {
	const chain = new Set<Worker>()
	let current: unknown = root
	while (current instanceof Worker) {
		chain.add(current)
		current = current.options.bindings?.['APP']
	}
	return chain
}

export interface AuthoredGraphLimits {
	/** The one hostname this environment may route; a route on any other host belongs to another app. */
	readonly domain?: string
	/** The KV namespace oblaka keeps this deploy's state in; naming the platform's own would clobber it. */
	readonly stateNamespace: string
	/** Fabrika deploying its own components is the one caller allowed to name a platform resource. */
	readonly platformResources: 'refuse' | 'allow'
}

/**
 * Refuse an authored graph before any Cloudflare call: the config comes from the checkout and the
 * deploy holds an account-wide token, so the names and routes it may claim are bounded here (ADR-0014).
 */
export const assertAuthoredGraph = (root: Worker, limits: AuthoredGraphLimits): void => {
	const deployable = applicationChain(root)
	const visit = (worker: Worker): void => {
		for (const route of worker.options.routes ?? []) {
			const host = routeHostname(route)
			if (host === null || !isProxyHost(host) || host !== limits.domain?.toLowerCase()) {
				throw new Error(`cloudflare: Worker \`${worker.options.name}\` routes \`${host ?? '(unreadable)'}\`, which is not this environment's domain`)
			}
		}
		for (const value of Object.values(worker.options.bindings ?? {})) {
			const resource = namedResource(value)
			if (resource !== null && limits.platformResources === 'refuse' && PLATFORM_RESOURCE_NAMES.has(resource.name)) {
				throw new Error(`cloudflare: ${resource.kind} \`${resource.name}\` is a Fabrika platform resource and cannot be declared by an app`)
			}
			const service = serviceReferenceTarget(value)
			if (
				service !== null
				&& limits.platformResources === 'refuse'
				&& service !== 'propustka-worker'
				&& (PLATFORM_RESOURCE_NAMES.has(service) || service === '(unreadable)')
			) {
				throw new Error(`cloudflare: service binding to \`${service}\` is a Fabrika platform service and cannot be bound by an app`)
			}
			if (value instanceof Worker) {
				if (!deployable.has(value)) {
					throw new Error(`cloudflare: config declares Worker \`${value.options.name}\`; only the application Worker and its proxy are deployable`)
				}
				visit(value)
			}
		}
	}
	if (limits.platformResources === 'refuse' && PLATFORM_RESOURCE_NAMES.has(root.options.name)) {
		throw new Error(`cloudflare: Worker \`${root.options.name}\` is a Fabrika platform resource and cannot be declared by an app`)
	}
	if (limits.platformResources === 'refuse' && PLATFORM_RESOURCE_NAMES.has(limits.stateNamespace)) {
		throw new Error(`cloudflare: state namespace \`${limits.stateNamespace}\` is a Fabrika platform resource and cannot be used by an app`)
	}
	visit(root)
}

export interface CloudflarePlanInput {
	readonly appId: string
	readonly env: string
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

	if (config.schema !== undefined) {
		add({ id: 'reconcile-schema', kind: 'reconcile-schema', description: 'Report the authz schema for the control plane to reconcile into IAM' })
	}

	if (config.pipeline?.secrets !== undefined && config.pipeline.secrets.length > 0) {
		add({ id: 'sync-secrets', kind: 'sync-secrets', description: `Sync ${config.pipeline.secrets.length} secret(s) via \`wrangler secret put\`` })
	}

	return { appId: input.appId, env: input.env, steps }
}
