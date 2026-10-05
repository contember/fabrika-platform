import { z } from 'zod'

const strings = z.array(z.string())
const stringOrList = z.union([z.string(), strings])
const environment = z.record(z.union([z.string(), z.number(), z.boolean()]))
// Installation images only; the provider's public catalog remains independent.
const runtime = z.enum(['alpine/bun@1.3', 'alpine@3.21', 'alpine/go@latest', 'alpine/nodejs@22', 'ubuntu/bun@1.3'])
// Live probes require strings; generated-value tests enforce the installation's [10s, 1h] policy.
const duration = z.string()
const httpGet = z.object({ scheme: z.string().optional(), host: z.string().optional(), port: z.number().int(), path: z.string() }).strict()
const exec = z.object({ command: z.string() }).strict()
const readinessCheck = z.object({
	httpGet: httpGet.optional(),
	exec: exec.optional(),
	failureTimeout: duration.optional(),
	retryPeriod: duration.optional(),
}).strict()
const healthCheck = z.object({
	httpGet: httpGet.optional(),
	exec: exec.optional(),
	failureTimeout: duration.optional(),
	disconnectTimeout: duration.optional(),
	recoveryTimeout: duration.optional(),
	execPeriod: duration.optional(),
}).strict()
const routing = z.object({
	root: z.string().optional(),
	cors: z.string().optional(),
	redirects: z.array(
		z.object({
			from: z.string(),
			to: z.string(),
			status: z.number().int().optional(),
			preservePath: z.boolean().optional(),
			preserveQuery: z.boolean().optional(),
		}).strict(),
	).optional(),
	headers: z.array(z.object({ for: z.string(), values: z.record(z.string()) }).strict()).optional(),
}).strict()
export const setupSchema = z.object({
	setup: z.string(),
	extends: stringOrList.optional(),
	build: z.object({
		os: z.enum(['alpine', 'ubuntu']).optional(),
		base: z.union([runtime, z.array(runtime)]).optional(),
		prepareCommands: strings.optional(),
		buildCommands: strings.optional(),
		deploy: stringOrList.optional(),
		deployFiles: stringOrList,
		cache: z.union([z.boolean(), stringOrList]).optional(),
		addToRunPrepare: stringOrList.optional(),
		envVariables: environment.optional(),
	}).strict().optional(),
	deploy: z.object({ readinessCheck: readinessCheck.optional(), temporaryShutdown: z.boolean().optional() }).strict().optional(),
	run: z.object({
		initCommands: strings.optional(),
		prepareCommands: strings.optional(),
		os: z.enum(['alpine', 'ubuntu']).optional(),
		base: runtime.optional(),
		start: z.string().optional(),
		documentRoot: z.string().optional(),
		siteConfigPath: z.string().optional(),
		envReplace: z.object({ target: stringOrList, delimiter: stringOrList }).strict().optional(),
		healthCheck: healthCheck.optional(),
		routing: routing.optional(),
		ports: z.array(z.object({ protocol: z.enum(['tcp', 'udp']).optional(), port: z.number().int(), httpSupport: z.boolean().optional() }).strict())
			.optional(),
		envVariables: environment.optional(),
		startCommands: z.array(
			z.object({ name: z.string().optional(), command: z.string(), workingDir: z.string().optional(), initCommands: strings.optional() }).strict(),
		).optional(),
		crontab: z.array(z.object({ timing: z.string(), command: z.string(), workingDir: z.string().optional(), allContainers: z.boolean() }).strict())
			.optional(),
	}).strict().optional(),
}).strict()
export const zeropsYamlSchema = z.object({ zerops: z.array(setupSchema) }).strict()

const autoscaling = z.object({
	cpu: z.number().int().min(1).max(8).optional(),
	minCpu: z.number().int().min(1).max(8).optional(),
	maxCpu: z.number().int().min(1).max(8).optional(),
	ram: z.number().min(0.125).max(48).optional(),
	minRam: z.number().min(0.125).max(48).optional(),
	maxRam: z.number().min(0.125).max(48).optional(),
	disk: z.number().min(1).max(250).optional(),
	minDisk: z.number().min(1).max(250).optional(),
	maxDisk: z.number().min(1).max(250).optional(),
	cpuMode: z.enum(['DEDICATED', 'SHARED']).optional(),
	startCpuCoreCount: z.number().int().optional(),
	swapEnabled: z.boolean().optional(),
	minFreeCpuCores: z.number().optional(),
	minFreeCpuPercent: z.number().optional(),
	minFreeRamGB: z.number().optional(),
	minFreeRamPercent: z.number().optional(),
	minVCpu: z.number().int().optional(),
	maxVCpu: z.number().int().optional(),
}).strict()
const postgresOverrides = z.object({
	autovacuum_analyze_scale_factor: z.number().optional(),
	autovacuum_max_workers: z.number().int().optional(),
	autovacuum_naptime: z.number().int().optional(),
	autovacuum_vacuum_cost_delay: z.number().int().optional(),
	autovacuum_vacuum_cost_limit: z.number().int().optional(),
	autovacuum_vacuum_scale_factor: z.number().optional(),
	autovacuum_work_mem: z.number().int().optional(),
	commit_delay: z.number().int().optional(),
	commit_siblings: z.number().int().optional(),
	default_statistics_target: z.number().int().optional(),
	effective_cache_size: z.number().int().optional(),
	effective_io_concurrency: z.number().int().optional(),
	hash_mem_multiplier: z.number().int().optional(),
	idle_in_transaction_session_timeout: z.number().int().optional(),
	jit_above_cost: z.number().optional(),
	maintenance_io_concurrency: z.number().int().optional(),
	maintenance_work_mem: z.number().int().optional(),
	max_parallel_maintenance_workers: z.number().int().optional(),
	max_parallel_workers: z.number().int().optional(),
	max_parallel_workers_per_gather: z.number().int().optional(),
	max_wal_size: z.number().int().optional(),
	max_worker_processes: z.number().int().optional(),
	min_wal_size: z.number().int().optional(),
	random_page_cost: z.number().optional(),
	temp_buffers: z.number().int().optional(),
	temp_file_limit: z.number().int().optional(),
	vacuum_cost_delay: z.number().int().optional(),
	wal_buffers: z.number().int().optional(),
	wal_compression: z.string().optional(),
	wal_writer_delay: z.number().int().optional(),
	wal_writer_flush_after: z.number().int().optional(),
	work_mem: z.number().int().optional(),
}).strict()
const commonService = z.object({
	hostname: z.string(),
	mode: z.string().optional(),
	envSecrets: z.record(z.string()).optional(),
	dotEnvSecrets: z.string().optional(),
	nginxConfig: z.string().optional(),
	objectStorageSize: z.number().optional(),
	objectStoragePolicy: z.enum(['custom', 'private', 'public-read', 'public-objects-read', 'public-write', 'public-read-write']).optional(),
	objectStorageRawPolicy: z.string().optional(),
	buildFromGit: z.string().optional(),
	startWithoutCode: z.boolean().optional(),
	enableSubdomainAccess: z.boolean().optional(),
	priority: z.number().int().optional(),
	mount: strings.optional(),
	enableCdn: z.boolean().optional(),
	envIsolation: z.string().optional(),
	sshIsolation: z.string().optional(),
	os: z.string().optional(),
	zeropsSetup: z.string().optional(),
	override: z.boolean().optional(),
}).strict()
const runtimeService = commonService.extend({
	type: runtime,
	minContainers: z.number().int().min(1).max(10).optional(),
	maxContainers: z.number().int().min(1).max(10).optional(),
	verticalAutoscaling: autoscaling.optional(),
})
const postgresService = commonService.extend({
	type: z.enum([
		'postgresql:ha@14',
		'postgresql:ha@16',
		'postgresql:ha@17',
		'postgresql:ha@18',
		'postgresql:single@14',
		'postgresql:single@16',
		'postgresql:single@17',
		'postgresql:single@18',
	]),
	profile: z.enum(['oltp-hobby', 'oltp-staging', 'oltp-production', 'oltp-enterprise', 'olap-production', 'writeheavy-production', 'custom'])
		.optional(),
	// Upstream leaves overrides unconstrained when no profile is selected.
	profileOverrides: z.unknown().optional(),
	verticalAutoscaling: autoscaling.extend({
		ram: z.number().min(0.25).max(48).optional(),
		minRam: z.number().min(0.25).max(48).optional(),
		maxRam: z.number().min(0.25).max(48).optional(),
	}).optional(),
}).superRefine((service, ctx) => {
	if (
		(service.type.startsWith('postgresql:ha@') && service.profile === 'oltp-hobby')
		|| (service.type.startsWith('postgresql:single@') && service.profile === 'oltp-enterprise')
	) {
		ctx.addIssue({ code: 'custom', path: ['profile'], message: 'profile is not supported by this PostgreSQL availability mode' })
	}
	if (service.profile !== undefined && service.profile !== 'custom' && service.profileOverrides !== undefined) {
		ctx.addIssue({ code: 'custom', path: ['profileOverrides'], message: 'profileOverrides requires the custom PostgreSQL profile' })
	}
	if (service.profile === 'custom' && service.profileOverrides !== undefined) {
		const overrides = postgresOverrides.safeParse(service.profileOverrides)
		if (!overrides.success) {
			for (const issue of overrides.error.issues) {
				ctx.addIssue({ ...issue, path: ['profileOverrides', ...issue.path] })
			}
		}
	}
})
const storageService = commonService.extend({
	type: z.enum(['object-storage', 'objectstorage']),
	verticalAutoscaling: autoscaling.omit({
		cpu: true,
		minCpu: true,
		maxCpu: true,
		ram: true,
		minRam: true,
		maxRam: true,
		disk: true,
		minDisk: true,
		maxDisk: true,
	}).optional(),
})
export const importSchema = z.object({
	project: z.object({
		name: z.string(),
		description: z.string().optional(),
		corePackage: z.enum(['LIGHT', 'SERIOUS']).optional(),
		tags: strings.optional(),
		envVariables: z.record(z.string()).optional(),
		envIsolation: z.string().optional(),
		sshIsolation: z.string().optional(),
		sharedIpv4: z.boolean().optional(),
		location: z.enum(['eu-central', 'us-east-1', 'us-west-1']).optional(),
	}).strict().optional(),
	services: z.array(z.union([runtimeService, postgresService, storageService])).optional(),
}).strict()
