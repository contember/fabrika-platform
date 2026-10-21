// The execution descriptor of a CONTRACT application (ADR-0043): the platform, not the repository, decides what
// runs. Of the authored setup only `build.base`, `build.os` and the SPA's `build.buildCommands` survive; the rest of
// the build, the deploy gate and the whole `run` section are generated here. PURE — no network, no filesystem.

import {
	type ContractArtifact,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_SOURCE_MAP_UPLOAD,
	FABRIKA_SOURCE_MAP_UPLOAD_KEY,
	type FrameworkVariableName,
} from '@fabrika/auth-core'
import type { OperationsAssetRoot, OperationsSourceMapBuildUpload } from '@fabrika/operations-contract/releases'
import { FRAMEWORK_RELEASE_PATTERN, type JsonValue } from '@fabrika/provider-contract'
import packageManifest from '../package.json'
import { renderYaml } from './compile'
import { parseZeropsDescriptor, type PreparedZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { assertAuthoredManagedDocument } from './managed-env'

/** The port the generated entrypoint listens on (`PORT`), and the one the proxy dials. */
export const ZEROPS_APPLICATION_PORT = 3000

/** The runtime every contract application runs on: the generated entrypoint is a Bun program. */
export const ZEROPS_APPLICATION_RUNTIME = 'alpine/bun@1.3'

/**
 * This package's own version. Control runs the git checkout of its release tag, so this reads the source version,
 * which `release:validate` holds equal to the tag; the public packages are released together, so it is the checker
 * release of the installation. A build checks with the application's own release instead (`checkRelease`).
 */
export const FABRIKA_CHECK_VERSION: string = packageManifest.version

/** The compiler the platform type-checks with. It is fetched by version, never taken from the application's lockfile. */
export const PLATFORM_TYPESCRIPT_VERSION = '5.9.3'

/** System packages an application may add to its runtime image, installed by the generated `run.prepareCommands`. */
export const ZEROPS_RUNTIME_PACKAGES = ['ffmpeg', 'ghostscript', 'imagemagick', 'poppler-utils', 'vips'] as const

export type ZeropsRuntimePackage = (typeof ZEROPS_RUNTIME_PACKAGES)[number]

export interface ZeropsContractJob {
	readonly name: string
	readonly schedule: string
}

/** The framework's file scan job (`@fabrika/app`'s `FILE_SCAN_JOB`), run every minute when a collection scans. */
export const ZEROPS_FILE_SCAN_JOB = 'fabrika-file-scan'
/** The framework's file sweep job (`@fabrika/app`'s `FILE_SWEEP_JOB` and its schedule), run when the contract has files. */
export const ZEROPS_FILE_SWEEP_JOB = 'fabrika-file-sweep'
const FILE_SWEEP_SCHEDULE = '41 * * * *'

/**
 * The RAM in GB a container of a scanning application starts with: one `clamscan` over a batch peaks at about 1 GB
 * resident while it loads its signatures (measured with ClamAV 1.4), beside the application's own process.
 */
export const ZEROPS_SCAN_MIN_RAM_GB = 2

/**
 * The RAM in GB a container of an application with a database starts with. Its init commands run `fabrika db
 * test-isolation`, whose CLI and `bun test` child together peak at 161 MiB of anonymous memory for the Notes example
 * and 225 MiB for the CRM example (measured locally, 2026-10-15), beside Bun's own mapped binary. Zerops' 0.125 GB
 * floor kills that within a second, faster than vertical autoscaling reacts.
 */
export const ZEROPS_START_MIN_RAM_GB = 0.5

/** The minimum RAM in GB the deploy service's containers need to start, or null when Zerops' floor suffices. */
export function zeropsStartMinRam(execution: ZeropsLockedExecution): number | null {
	if (execution.contract.scan === true) return ZEROPS_SCAN_MIN_RAM_GB
	return execution.databaseUrl === null ? null : ZEROPS_START_MIN_RAM_GB
}

/** What a scanning application adds: ClamAV in the image with its first signatures, refreshed at start and daily. */
const SCANNER_PACKAGE = 'clamav'
const FRESHCLAM = 'sudo freshclam --stdout --quiet'
const FRESHCLAM_SCHEDULE = '17 4 * * *'

/** What the generated run section needs from a contract; derived from the artifact by `zeropsContractRun`. */
export interface ZeropsContractRun {
	/** The contract digest the application compares at startup (`FABRIKA_CONTRACT_DIGEST`). */
	readonly digest: string
	/** The path of the contract's health endpoint, which the readiness and health checks request. */
	readonly readinessPath: string
	readonly jobs: readonly ZeropsContractJob[]
	/** Present when the contract declares a file collection: the crontab runs the sweep of removed files. */
	readonly files?: true
	/** Present when a file collection scans its uploads: the build installs ClamAV and the crontab runs the scan. */
	readonly scan?: true
}

/** Everything one locked execution descriptor is rendered from. */
export interface ZeropsLockedExecution {
	readonly appId: string
	readonly contract: ZeropsContractRun
	/**
	 * The release of the reader that read the application (`ProviderApprovedAccess.checker`), the newest patch of the
	 * framework minor it pins: the build runs `fabrika-check` and `fabrika-source-maps` of `@fabrika/check` at it.
	 */
	readonly checkRelease: string
	/** A `${host_…}` reference to the application's PostgreSQL service, or null when it has none. */
	readonly databaseUrl: string | null
	/**
	 * The most connections each process of the application opens (`FABRIKA_APP_DATABASE_CONNECTIONS`), as the deploy's
	 * `size-database` step sized it from the database's limit; null until then, and without a database.
	 */
	readonly databaseConnections: number | null
	/** The hostname of the application's one object-storage service, or null when it has none. */
	readonly storageHostname: string | null
	readonly runtimePackages: readonly ZeropsRuntimePackage[]
	/** Where the build uploads its source maps, without the bearer; null when Control minted no upload for the run. */
	readonly sourceMaps: OperationsSourceMapBuildUpload | null
}

/** The application ids the generated scripts may name: the contract's own id rule, so a script needs no quoting. */
export const LOCKED_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export const CONTRACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

const byName = <T extends { readonly name: string }>(left: T, right: T): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0

/**
 * The run facts of a contract, with the digest the application's own release computes for it. A contract without a
 * health endpoint has nothing a readiness check can request.
 */
export function zeropsContractRun(artifact: ContractArtifact, digest: string): ZeropsContractRun {
	const health = artifact.endpoints.filter((row) => row.kind === 'health').sort((left, right) => left.id < right.id ? -1 : 1)[0]
	if (health === undefined) {
		throw new Error(
			"fabrika app build: a contract application on Zerops needs a health endpoint for its readiness check (allowed form: health: c.health('/healthz'))",
		)
	}
	const fileKinds = Object.values(artifact.fileKinds ?? {})
	return {
		digest,
		readinessPath: health.path,
		jobs: Object.entries(artifact.jobs).map(([name, job]) => ({ name, schedule: job.schedule })).sort(byName),
		...(Object.keys(artifact.files).length > 0 || fileKinds.length > 0 ? { files: true } : {}),
		...([...Object.values(artifact.files), ...fileKinds].some((declared) => declared.scan === true) ? { scan: true } : {}),
	}
}

/**
 * A scanning application's deploy service must start its containers with `ZEROPS_SCAN_MIN_RAM_GB`: below it the
 * scanner is killed for memory, and every upload stays quarantined. Zerops ignores a changed `verticalAutoscaling` of
 * an existing service on a re-import, so the deploy's `raise-start-memory` step raises an existing service.
 */
export function assertScanMemory(services: readonly { readonly [key: string]: JsonValue }[], deployService: string, run: ZeropsContractRun): void {
	if (run.scan !== true) return
	const service = services.find((candidate) => candidate['hostname'] === deployService)
	const scaling = service?.['verticalAutoscaling']
	const minRam = isMapping(scaling) ? scaling['minRam'] : undefined
	if (typeof minRam !== 'number' || minRam < ZEROPS_SCAN_MIN_RAM_GB) {
		throw new Error(
			`fabrika app build: a contract with scan: true scans uploads with ClamAV, which needs ${ZEROPS_SCAN_MIN_RAM_GB} GB of RAM; set verticalAutoscaling: { minRam: ${ZEROPS_SCAN_MIN_RAM_GB} } on the service \`${deployService}\``,
		)
	}
}

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

const LOCKED_BUILD_FORM = 'only `build.base`, `build.os` and the SPA commands in `build.buildCommands`'

const RUN_REASON = 'the platform generates the run section: the entrypoint, `fabrika db migrate`, the readiness check and the crontab'

/** Every key the authored selected setup may not carry, with why. Any key not listed and not authorable is refused too. */
const REFUSED_KEYS: Readonly<Record<string, string>> = {
	extends: 'an inherited setup brings keys the platform generates',
	deploy: 'the platform generates the deploy gate',
	'deploy.temporaryShutdown': 'the platform decides how a version replaces the running one',
	'deploy.readinessCheck': 'the platform generates the readiness check against the contract health endpoint',
	'build.addToRunPrepare': 'a file copied into the runtime image skips the build checks',
	'build.deployFiles': 'the platform deploys the checked build',
	'build.deploy': 'the platform deploys the checked build',
	'build.prepareCommands': 'a build-image command runs before the checks and outside them',
	'build.cache': 'a cached path survives into the next build unchecked',
	'build.envVariables': 'a build variable can redirect the generated checks',
}

const AUTHORED_SETUP_KEYS: ReadonlySet<string> = new Set(['setup', 'build'])
const AUTHORED_BUILD_KEYS: ReadonlySet<string> = new Set(['base', 'os', 'buildCommands'])

const isMapping = (value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } =>
	typeof value === 'object' && value !== null && !Array.isArray(value)

const isStringList = (value: JsonValue): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === 'string')

const refuse = (setup: string, key: string, reason: string): never => {
	throw new Error(`invalid fabrika manifest: zerops.yaml setup \`${setup}\` sets \`${key}\`; ${reason} (allowed form: ${LOCKED_BUILD_FORM})`)
}

/** The directories a contract serves its pages from: each SPA mount's and each share link's SPA, by URL prefix. */
export function zeropsAssetRoots(artifact: ContractArtifact): OperationsAssetRoot[] {
	const roots: OperationsAssetRoot[] = []
	for (const mount of Object.values(artifact.mounts)) {
		if (mount.kind === 'spa') roots.push({ prefix: mount.prefix, dir: mount.dir })
		if (mount.kind === 'link') roots.push({ prefix: mount.prefix, dir: mount.spa })
	}
	return roots.sort((left, right) => left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0)
}

interface AuthoredBuild {
	readonly base: string | string[] | null
	readonly os: string | null
	readonly commands: string[]
}

/** Refuse every key of a contract application's setup the platform owns, and return what it keeps. */
export function lockedAuthoredBuild(entry: { readonly [key: string]: JsonValue }, setup: string): AuthoredBuild {
	for (const key of Object.keys(entry)) {
		if (key === 'run') {
			const run = entry[key]
			const first = isMapping(run) ? Object.keys(run)[0] : undefined
			refuse(setup, first === undefined ? 'run' : `run.${first}`, RUN_REASON)
		}
		if (key === 'deploy') {
			const deploy = entry[key]
			const first = isMapping(deploy) ? Object.keys(deploy)[0] : undefined
			const path = first === undefined ? 'deploy' : `deploy.${first}`
			refuse(setup, path, REFUSED_KEYS[path] ?? REFUSED_KEYS['deploy'] ?? '')
		}
		if (!AUTHORED_SETUP_KEYS.has(key)) refuse(setup, key, REFUSED_KEYS[key] ?? 'the platform generates every other setup key')
	}
	const build = entry['build']
	if (build === undefined) return { base: null, os: null, commands: [] }
	if (!isMapping(build)) return refuse(setup, 'build', 'a build is a mapping')
	for (const key of Object.keys(build)) {
		if (!AUTHORED_BUILD_KEYS.has(key)) refuse(setup, `build.${key}`, REFUSED_KEYS[`build.${key}`] ?? 'the platform generates every other build key')
	}
	const base = build['base']
	const os = build['os']
	const commands = build['buildCommands']
	if (base !== undefined && typeof base !== 'string' && !isStringList(base)) refuse(setup, 'build.base', 'a base is a name or a list of names')
	if (os !== undefined && typeof os !== 'string') refuse(setup, 'build.os', 'an os is a name')
	if (commands !== undefined && !isStringList(commands)) refuse(setup, 'build.buildCommands', 'build commands are a list of strings')
	return {
		base: typeof base === 'string' || (base !== undefined && isStringList(base)) ? base : null,
		os: typeof os === 'string' ? os : null,
		commands: commands !== undefined && isStringList(commands) ? commands : [],
	}
}

// ── Generation ───────────────────────────────────────────────────────────────────────────────────

const SOURCE_ROOT = '/build/source'
const RUNTIME_ROOT = '/var/www'
const FABRIKA_BIN = './node_modules/.bin/fabrika'
const MIGRATE_SCRIPT = 'fabrika/migrate.generated.sh'
const VERIFY_SCRIPT = 'fabrika/verify.generated.sh'
const START_SCRIPT = 'fabrika/start.generated.sh'
const PLATFORM_TSCONFIG = 'fabrika/tsconfig.platform.json'

/** The compiler options of the platform's type check; the application's own `tsconfig.json` and its `paths` are not read. */
const PLATFORM_TSCONFIG_CONTENTS = JSON.stringify({
	compilerOptions: {
		target: 'ES2022',
		module: 'ESNext',
		moduleResolution: 'bundler',
		lib: ['ES2022', 'DOM', 'DOM.Iterable'],
		types: ['bun'],
		strict: true,
		noUncheckedIndexedAccess: true,
		noImplicitOverride: true,
		forceConsistentCasingInFileNames: true,
		skipLibCheck: true,
		resolveJsonModule: true,
		isolatedModules: true,
		noEmit: true,
	},
	include: ['../fabrika.contract.ts', '../src', 'entry.generated.ts'],
})

/** One `printf` writing `lines` to `path`. Each line is single-quoted, so it may hold neither `'` nor an expansion. */
const writeFileCommand = (path: string, lines: readonly string[]): string => {
	for (const line of lines) {
		if (line.includes("'") || line.includes('$')) throw new Error('zerops: a generated file line must not contain a quote or an expansion')
	}
	return `printf '%s\\n' ${lines.map((line) => `'${line}'`).join(' ')} > ${path}`
}

const migrateScript = (appId: string): readonly string[] => [
	'#!/bin/sh',
	'set -eu',
	`cd ${RUNTIME_ROOT}`,
	`FABRIKA_APP_ID=${appId} exec ${FABRIKA_BIN} db migrate`,
]

// The committed schema types must match the migrated schema and every generated isolation test must pass on a throwaway
// schema. The build has no database, so they run at container start, after the migrations, as init commands: a failed
// init command stops the activation (verified live), and a run as long as the CRM's ~3 minutes of generated cases does
// not race the readiness window. UNVERIFIED: that the window opens with `run.start`, after the init commands; one
// runtime log shows it, and the platform-facts row `slow-init-command-precedes-the-readiness-window` measures it.
const verifyScript = (appId: string): readonly string[] => [
	'#!/bin/sh',
	'set -eu',
	`cd ${RUNTIME_ROOT}`,
	`FABRIKA_APP_ID=${appId} ${FABRIKA_BIN} db codegen --verify`,
	`FABRIKA_APP_ID=${appId} exec ${FABRIKA_BIN} db test-isolation`,
]

const startScript: readonly string[] = ['#!/bin/sh', 'set -eu', `cd ${RUNTIME_ROOT}`, 'exec bun fabrika/entry.generated.ts']

/** The scripts the build writes and every container's init commands run, in this order. */
const initScripts = (execution: ZeropsLockedExecution): readonly { readonly path: string; readonly lines: readonly string[] }[] =>
	execution.databaseUrl === null
		? []
		: [{ path: MIGRATE_SCRIPT, lines: migrateScript(execution.appId) }, { path: VERIFY_SCRIPT, lines: verifyScript(execution.appId) }]

const INSTALL = 'bun install --frozen-lockfile --ignore-scripts'

// After every check: a map is uploaded only for a build that can deploy. A failed upload never fails the build; the
// provider reads the state from the report line.
const sourceMapUpload = (release: string): string => `cd /tmp && bun x --bun -p @fabrika/check@${release} fabrika-source-maps ${SOURCE_ROOT} || true`

/**
 * The upload's build variables: the destination and asset roots as a literal, and the bearer lifted from the service
 * variable the deploy wrote sensitive, so the descriptor never holds it.
 */
const sourceMapBuildVariables = (upload: OperationsSourceMapBuildUpload): Record<string, string> => {
	const value = JSON.stringify(upload)
	// Zerops resolves `${…}` in a build variable, so an SPA directory carrying one would read another variable.
	if (value.includes('${')) throw new Error('zerops: an SPA directory or prefix must not contain `${`')
	return { [FABRIKA_SOURCE_MAP_UPLOAD]: value, [FABRIKA_SOURCE_MAP_UPLOAD_KEY]: `\${RUNTIME_${FABRIKA_SOURCE_MAP_UPLOAD_KEY}}` }
}

/**
 * The generated build commands, in order; the authored SPA commands run before all of them. The application's tests
 * run first: they are authored code, so everything after them is reinstalled, regenerated or checked again. They run
 * `--isolate`, as the application skill runs them: a test file's DOM globals otherwise leak into the next file.
 */
export function generatedBuildCommands(execution: ZeropsLockedExecution): readonly string[] {
	if (!LOCKED_APP_ID_PATTERN.test(execution.appId)) throw new Error('zerops: a contract application id must match [a-z0-9][a-z0-9-]*')
	if (!FRAMEWORK_RELEASE_PATTERN.test(execution.checkRelease)) throw new Error('zerops: the checker release must be a release version')
	return [
		INSTALL,
		'bun test --isolate --pass-with-no-tests',
		`rm -rf node_modules && ${INSTALL}`,
		`bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"`,
		`cd /tmp && bun x --bun -p @fabrika/check@${execution.checkRelease} fabrika-check ${SOURCE_ROOT}`,
		writeFileCommand(PLATFORM_TSCONFIG, [PLATFORM_TSCONFIG_CONTENTS]),
		`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p ${SOURCE_ROOT}/${PLATFORM_TSCONFIG}`,
		...initScripts(execution).map((script) => writeFileCommand(script.path, script.lines)),
		writeFileCommand(START_SCRIPT, startScript),
		...(execution.sourceMaps === null ? [] : [sourceMapUpload(execution.checkRelease)]),
	]
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

type StorageVariable = Extract<FrameworkVariableName, `FABRIKA_APP_STORAGE_${string}`>

/** The file collections' object storage, as references Zerops resolves at runtime: no credential passes through Fabrika. */
const storageVariables = (hostname: string): Record<StorageVariable, string> => ({
	FABRIKA_APP_STORAGE_ENDPOINT: `\${${hostname}_apiUrl}`,
	FABRIKA_APP_STORAGE_BUCKET: `\${${hostname}_bucketName}`,
	FABRIKA_APP_STORAGE_ACCESS_KEY_ID: `\${${hostname}_accessKeyId}`,
	FABRIKA_APP_STORAGE_SECRET_ACCESS_KEY: `\${${hostname}_secretAccessKey}`,
})

/** The crontab lines that run a job of the contract or of the framework, each on one container. */
const jobCrontab = (contract: ZeropsContractRun): { readonly timing: string; readonly command: string; readonly allContainers: boolean }[] => [
	...contract.jobs.map((job) => ({ timing: job.schedule, command: `${FABRIKA_BIN} job run ${job.name}`, allContainers: false })),
	...(contract.files === true
		? [{ timing: FILE_SWEEP_SCHEDULE, command: `${FABRIKA_BIN} job run ${ZEROPS_FILE_SWEEP_JOB}`, allContainers: false }]
		: []),
	...(contract.scan === true ? [{ timing: '* * * * *', command: `${FABRIKA_BIN} job run ${ZEROPS_FILE_SCAN_JOB}`, allContainers: false }] : []),
]

/** How many job processes the crontab may run at once, each opening the application's database. */
export const zeropsJobProcesses = (contract: ZeropsContractRun): number => jobCrontab(contract).length

/** The commands every container runs before `run.start`, in order; any failure stops the activation. */
export function generatedInitCommands(execution: ZeropsLockedExecution): string[] {
	return [
		// A container starts from the prepared image, whose signatures are as old as its build; a failed refresh leaves
		// them to the daily one, and the scanner refuses signatures older than three days, so the scan fails closed.
		...(execution.contract.scan === true ? [`${FRESHCLAM} || echo 'fabrika: freshclam did not refresh the malware signatures'`] : []),
		...initScripts(execution).map((script) => `sh ${RUNTIME_ROOT}/${script.path}`),
	]
}

/** The generated selected setup: the authored build kept, everything else the platform's. */
export function renderLockedSetup(
	setup: string,
	authored: AuthoredBuild,
	release: string | null,
	execution: ZeropsLockedExecution,
): { readonly [key: string]: JsonValue } {
	const { contract } = execution
	if (!CONTRACT_DIGEST_PATTERN.test(contract.digest)) throw new Error('zerops: a contract digest must be sha256:<64 hex digits>')
	const probe = { port: ZEROPS_APPLICATION_PORT, path: contract.readinessPath }
	const envVariables: Record<string, string> = {
		PORT: String(ZEROPS_APPLICATION_PORT),
		[FABRIKA_CONTRACT_DIGEST]: contract.digest,
		...(release === null ? {} : { FABRIKA_RELEASE: release }),
		...(execution.databaseUrl === null ? {} : { FABRIKA_APP_DATABASE_URL: execution.databaseUrl }),
		...(execution.databaseConnections === null ? {} : { FABRIKA_APP_DATABASE_CONNECTIONS: String(execution.databaseConnections) }),
		...(execution.storageHostname === null ? {} : storageVariables(execution.storageHostname)),
	}
	const scan = contract.scan === true
	const packages = sortedUnique([...execution.runtimePackages, ...(scan ? [SCANNER_PACKAGE] : [])])
	// Every container keeps its own signatures; one scan pass at a time holds the job's lease.
	const crontab = [...jobCrontab(contract), ...(scan ? [{ timing: FRESHCLAM_SCHEDULE, command: FRESHCLAM, allContainers: true }] : [])]
	const initCommands = generatedInitCommands(execution)
	const prepareCommands = packages.length === 0 ? [] : [`sudo apk add --no-cache ${packages.join(' ')}`, ...(scan ? [FRESHCLAM] : [])]
	return {
		setup,
		build: {
			base: authored.base ?? [ZEROPS_APPLICATION_RUNTIME],
			...(authored.os === null ? {} : { os: authored.os }),
			buildCommands: [...authored.commands, ...generatedBuildCommands(execution)],
			...(execution.sourceMaps === null ? {} : { envVariables: sourceMapBuildVariables(execution.sourceMaps) }),
			deployFiles: ['./'],
			cache: ['node_modules'],
		},
		deploy: {
			readinessCheck: { httpGet: probe, retryPeriod: '10s', failureTimeout: '180s' },
		},
		run: {
			base: ZEROPS_APPLICATION_RUNTIME,
			...(prepareCommands.length === 0 ? {} : { prepareCommands }),
			...(initCommands.length === 0 ? {} : { initCommands }),
			start: `sh ${RUNTIME_ROOT}/${START_SCRIPT}`,
			ports: [{ port: ZEROPS_APPLICATION_PORT, httpSupport: true }],
			healthCheck: { httpGet: probe, execPeriod: '10s', disconnectTimeout: '30s', recoveryTimeout: '10s', failureTimeout: '120s' },
			...(crontab.length === 0 ? {} : { crontab }),
			envVariables,
		},
	}
}

/**
 * The execution descriptor of a contract application: only the selected setup, generated. The source descriptor's
 * bytes and digest stay the artifact's identity; this document is what the build request carries.
 */
export function renderLockedExecutionDescriptor(
	contents: string,
	setup: string | undefined,
	release: string | null,
	execution: ZeropsLockedExecution,
): PreparedZeropsDescriptor {
	if (release?.includes('${') === true) throw new Error('zerops: a release name must not contain `${`')
	const parsed = parseZeropsDescriptor(contents)
	assertAuthoredManagedDocument(parsed.document)
	const selected = selectZeropsDescriptorSetup(parsed, setup)
	const entries = parsed.document['zerops']
	const entry = Array.isArray(entries) ? entries.find((candidate) => isMapping(candidate) && candidate['setup'] === selected) : undefined
	if (!isMapping(entry)) throw new Error('zerops: descriptor requires setup entries')
	const authored = lockedAuthoredBuild(entry, selected)
	return { contents: renderYaml({ zerops: [renderLockedSetup(selected, authored, release, execution)] }), setup: selected }
}
