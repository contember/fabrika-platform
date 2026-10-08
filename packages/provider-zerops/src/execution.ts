// The execution descriptor of a CONTRACT application (ADR-0043): the platform, not the repository, decides what
// runs. Of the authored setup only `build.base`, `build.os` and the SPA's `build.buildCommands` survive; the rest of
// the build, the deploy gate and the whole `run` section are generated here. PURE — no network, no filesystem.

import { type ContractArtifact, contractDigest, FABRIKA_CONTRACT_DIGEST } from '@fabrika/auth-core'
import type { JsonValue } from '@fabrika/provider-contract'
import packageManifest from '../package.json'
import { renderYaml } from './compile'
import { parseZeropsDescriptor, type PreparedZeropsDescriptor, selectZeropsDescriptorSetup } from './descriptor'
import { assertAuthoredManagedDocument } from './managed-env'

/** The port the generated entrypoint listens on (`PORT`), and the one the proxy dials. */
export const ZEROPS_APPLICATION_PORT = 3000

/** The runtime every contract application runs on: the generated entrypoint is a Bun program. */
export const ZEROPS_APPLICATION_RUNTIME = 'alpine/bun@1.3'

/**
 * The checker every build runs, pinned to this package's own version: the public packages are released together
 * (`release:validate`), so this is the checker of the installation that renders the build.
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

/** What the generated run section needs from a contract; derived from the artifact by `zeropsContractRun`. */
export interface ZeropsContractRun {
	/** The contract digest the application compares at startup (`FABRIKA_CONTRACT_DIGEST`). */
	readonly digest: string
	/** The path of the contract's health endpoint, which the readiness and health checks request. */
	readonly readinessPath: string
	readonly jobs: readonly ZeropsContractJob[]
}

/** Everything one locked execution descriptor is rendered from. */
export interface ZeropsLockedExecution {
	readonly appId: string
	readonly contract: ZeropsContractRun
	/** A `${host_…}` reference to the application's PostgreSQL service, or null when it has none. */
	readonly databaseUrl: string | null
	readonly runtimePackages: readonly ZeropsRuntimePackage[]
}

/** The application ids the generated scripts may name: the contract's own id rule, so a script needs no quoting. */
export const LOCKED_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

export const CONTRACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/

const byName = <T extends { readonly name: string }>(left: T, right: T): number => left.name < right.name ? -1 : left.name > right.name ? 1 : 0

/** The run facts of a contract. A contract without a health endpoint has nothing a readiness check can request. */
export function zeropsContractRun(artifact: ContractArtifact): ZeropsContractRun {
	const health = artifact.endpoints.filter((row) => row.kind === 'health').sort((left, right) => left.id < right.id ? -1 : 1)[0]
	if (health === undefined) {
		throw new Error(
			"fabrika app build: a contract application on Zerops needs a health endpoint for its readiness check (allowed form: health: c.health('/healthz'))",
		)
	}
	return {
		digest: contractDigest(artifact),
		readinessPath: health.path,
		jobs: Object.entries(artifact.jobs).map(([name, job]) => ({ name, schedule: job.schedule })).sort(byName),
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

// The server starts only after the migrations it expects are applied, so a failed migration fails the readiness check
// even if a failed `initCommands` did not stop the activation (an unverified platform fact).
const startScript = (database: boolean): readonly string[] => [
	'#!/bin/sh',
	'set -eu',
	`cd ${RUNTIME_ROOT}`,
	...(database ? [`sh ${RUNTIME_ROOT}/${MIGRATE_SCRIPT}`] : []),
	'exec bun fabrika/entry.generated.ts',
]

/** The generated build commands, in order; the authored SPA commands run before all of them. */
export function generatedBuildCommands(execution: ZeropsLockedExecution): readonly string[] {
	if (!LOCKED_APP_ID_PATTERN.test(execution.appId)) throw new Error('zerops: a contract application id must match [a-z0-9][a-z0-9-]*')
	const database = execution.databaseUrl !== null
	return [
		'bun install --frozen-lockfile --ignore-scripts',
		`cd /tmp && bun x --bun -p @fabrika/check@${FABRIKA_CHECK_VERSION} fabrika-check ${SOURCE_ROOT}`,
		`bun -e "await import('@fabrika/app/build').then((build) => build.writeGeneratedEntry('.', 'bun'))"`,
		writeFileCommand(PLATFORM_TSCONFIG, [PLATFORM_TSCONFIG_CONTENTS]),
		`cd /tmp && bun x --bun -p typescript@${PLATFORM_TYPESCRIPT_VERSION} tsc -p ${SOURCE_ROOT}/${PLATFORM_TSCONFIG}`,
		'bun test --pass-with-no-tests',
		...(database ? [writeFileCommand(MIGRATE_SCRIPT, migrateScript(execution.appId))] : []),
		writeFileCommand(START_SCRIPT, startScript(database)),
	]
}

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort()

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
	}
	const packages = sortedUnique(execution.runtimePackages)
	return {
		setup,
		build: {
			base: authored.base ?? [ZEROPS_APPLICATION_RUNTIME],
			...(authored.os === null ? {} : { os: authored.os }),
			buildCommands: [...authored.commands, ...generatedBuildCommands(execution)],
			deployFiles: ['./'],
			cache: ['node_modules'],
		},
		deploy: {
			readinessCheck: { httpGet: probe, retryPeriod: '10s', failureTimeout: '180s' },
		},
		run: {
			base: ZEROPS_APPLICATION_RUNTIME,
			...(packages.length === 0 ? {} : { prepareCommands: [`sudo apk add --no-cache ${packages.join(' ')}`] }),
			...(execution.databaseUrl === null ? {} : { initCommands: [`sh ${RUNTIME_ROOT}/${MIGRATE_SCRIPT}`] }),
			start: `sh ${RUNTIME_ROOT}/${START_SCRIPT}`,
			ports: [{ port: ZEROPS_APPLICATION_PORT, httpSupport: true }],
			healthCheck: { httpGet: probe, execPeriod: '10s', disconnectTimeout: '30s', recoveryTimeout: '10s', failureTimeout: '120s' },
			...(contract.jobs.length === 0 ? {} : {
				crontab: contract.jobs.map((job) => ({ timing: job.schedule, command: `${FABRIKA_BIN} job run ${job.name}`, allContainers: false })),
			}),
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
