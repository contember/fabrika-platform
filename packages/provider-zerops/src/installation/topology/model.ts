// The installation model (ADR-0092) as Zerops renders it: the neutral model with Control's Zerops entry points, and the
// pieces of a `zerops.yaml` setup that come from it. What stays Zerops' own (the build recipes, the probe timings, the
// proxy's subdomain listeners, the data services' placement) is in `./setups.ts` and `./topology.ts`.

import {
	checkProviderVariables,
	type ModelService,
	type ModelVariable,
	type PlatformBucket,
	type PlatformDatabase,
	type PlatformInstallationModel,
	platformInstallationModel,
	staticEnvironment,
} from '@fabrika/installation-init'
import type { ZeropsHealthCheckSpec, ZeropsReadinessCheckSpec, ZeropsYamlDeploySpec, ZeropsYamlRunSpec } from '../../index'
import type { PlatformTier } from './topology'

/** The platform installation every Zerops release renders, with Control's Zerops composition root. */
export const zeropsInstallationModel: PlatformInstallationModel = platformInstallationModel({
	control: {
		migrate: 'packages/control/src/zerops/migrate.ts',
		server: 'packages/control/src/zerops/server.ts',
		job: 'packages/control/src/zerops/cron.ts',
	},
})

/**
 * Control's Zerops variables, beside the model's (ADR-0092), with the model's kinds. `install-environment.ts` and
 * `deploy.ts` write them; `__tests__/model.test.ts` holds what they write to this list.
 */
export const ZEROPS_CONTROL_VARIABLES: readonly ModelVariable[] = checkProviderVariables(zeropsInstallationModel, 'control', [
	{ kind: 'bring-up', name: 'FABRIKA_ZEROPS_CLIENT_ID', sensitive: false },
	// The namespace proxies' source, from the verified snapshot of the release a deploy runs.
	{ kind: 'derived', name: 'FABRIKA_ZEROPS_PROXY_SOURCE_JSON', sensitive: false },
	// The PUBLIC IAM origin an application project's proxy reaches: there is no private network between projects.
	{ kind: 'derived', name: 'FABRIKA_ZEROPS_PROXY_IAM_URL', sensitive: false },
	// IAM's proxy key, which Control hands to the namespace proxies.
	{ kind: 'generated', name: 'FABRIKA_ZEROPS_PROXY_IAM_KEY', secret: 'proxyKey' },
	// The integration token `platform install` mints for Control: the provider's own credential.
	{ kind: 'generated', name: 'FABRIKA_ZEROPS_ACCESS_TOKEN' },
	// The installation's own project, which no deployment namespace may adopt.
	{ kind: 'derived', name: 'FABRIKA_ZEROPS_PLATFORM_PROJECT_ID', sensitive: false },
	// Only when the installation is not on the default region.
	{ kind: 'bring-up', name: 'FABRIKA_ZEROPS_API_BASE_URL', sensitive: false, when: 'provider-option' },
])

/** Which data service of a tier holds each of the model's stores (`./topology.ts` declares the services). */
export interface ZeropsDataPlacement {
	readonly databases: Readonly<Record<PlatformDatabase, string>>
	readonly buckets: Readonly<Record<PlatformBucket, string>>
}

/**
 * IAM and Control share `db` and `storage` on both tiers; Operations has its own database on both, and its own bucket on
 * `standard`. A light installation created before Operations had its own database still reads `db`: the bring-up wrote
 * its references once, and no deploy rewrites them.
 */
export const ZEROPS_DATA_PLACEMENT: Readonly<Record<PlatformTier, ZeropsDataPlacement>> = {
	standard: {
		databases: { iam: 'db', control: 'db', operations: 'operationsdb' },
		buckets: { runLogs: 'storage', operationsBlobs: 'operationsstorage' },
	},
	light: {
		databases: { iam: 'db', control: 'db', operations: 'operationsdb' },
		buckets: { runLogs: 'storage', operationsBlobs: 'storage' },
	},
}

/** A service's deploy gate: the model's health path, at Zerops' readiness timings. */
export const zeropsReadiness = (service: ModelService, timings: Omit<ZeropsReadinessCheckSpec, 'httpGet' | 'exec'>): ZeropsYamlDeploySpec => ({
	readinessCheck: { httpGet: { port: service.health.port, path: service.health.path }, ...timings },
})

/** A Bun service's migration, start, listeners, scheduled jobs and fixed variables, as its setup's `run` writes them. */
export const zeropsServiceRun = (
	service: ModelService,
	liveness: Omit<ZeropsHealthCheckSpec, 'httpGet' | 'exec'>,
	base: string,
	/** Fixed variables Zerops writes beyond the model's, after them. */
	extraEnvironment: Readonly<Record<string, string>> = {},
): ZeropsYamlRunSpec => {
	const { entry } = service
	if (entry === undefined) throw new Error(`zerops: ${service.name} starts from its artifact and has no Bun entry`)
	return {
		base,
		// Migrations at container start. Safe to repeat: the runner records what it applied and serializes concurrent
		// containers behind a session-level advisory lock. Runs in /var/www.
		...(entry.migrate === undefined ? {} : { initCommands: [`bun ${entry.migrate}`] }),
		start: `bun ${entry.server}`,
		// The project's L7 balancer terminates TLS and forwards plain HTTP over the private network.
		ports: service.ports.map((port) => ({ port: port.port, httpSupport: port.http })),
		healthCheck: { httpGet: { port: service.health.port, path: service.health.path }, ...liveness },
		// `allContainers: false`: a job runs once per schedule across a horizontally scaled service.
		crontab: service.jobs.map((job) => ({ timing: job.schedule, command: `bun ${job.command}`, allContainers: false })),
		// A Zerops hostname is the service's name, so a private address is `http://<service>:<port>`.
		envVariables: { ...Object.fromEntries(staticEnvironment(zeropsInstallationModel, service.name)), ...extraEnvironment },
	}
}
