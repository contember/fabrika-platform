import {
	CLOUDFLARE_APPLICATION_BINDING,
	CLOUDFLARE_APPLICATION_CLASS,
	CLOUDFLARE_FILES_BINDING,
	type ContractCheck,
	contractChecks,
	GENERATED_ENTRY_FILE,
	SCHEMA_TYPES_CHECK,
} from '@fabrika/app/build'
import {
	API_KEY_PREFIX,
	type AppEnvironment,
	appEnvironmentId,
	type ApplicationObjects,
	type AppSchema,
	connectVariables,
	type ContractArtifact,
	contractDigest,
	DEFAULT_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECT,
	FABRIKA_APPLICATION_OBJECTS,
	FABRIKA_CONTRACT_DIGEST,
	FABRIKA_IAM_APP_ID,
	FABRIKA_IAM_ISSUER,
	FABRIKA_PROXY_SECRET,
	isFrameworkVariableName,
	isManagedCredential,
	managedValue,
	OPS_REHEARSAL_OBJECT,
	parseManagedEnvironment,
} from '@fabrika/auth-core'
import { type DeployStepResult, type ProviderManagedEnvironment, runSteps, type SchemaReconciler } from '@fabrika/provider-contract'
import { isPolicyOrigin } from '@fabrika/proxy-core/headers'
import { contractProxyTable, FABRIKA_PROXY_MANIFEST_JSON } from '@fabrika/proxy-core/manifest'
import { createHash } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { DurableObject, type GeneratedConfig, R2Bucket, ServiceReference, Worker } from 'oblaka-iac'
import { assertLiteralAssets } from './assets'
import type { CloudflareAppConfig } from './authoring'
import {
	type ApplicationRuntime,
	assertGeneratedConfigs,
	assertGeneration,
	assertStateNamespace,
	type DeploymentBounds,
	frameworkValues,
	generateWranglerConfigs,
} from './bounds'
import { runnerWorkerGraph } from './checkout'
import { type CloudflareCollaborators, type CommandResult, defaultCloudflareCollaborators } from './collaborators'
import { configSchema } from './config-schema'
import {
	assertCloudflareContract,
	capsJobSegments,
	checksSqliteSchema,
	namesSchemaCheckConfig,
	needsMinuteTick,
	pinsGeneratedEntry,
	runsInObject,
	servesAlarms,
	servesOps,
	servesRawSql,
} from './contract-support'
import { assertCustomDomainsOwned, customDomainHosts } from './custom-domains'
import { deployOrder } from './deploy-order'
import { localWorkloadKeyVariables } from './local-workload-keys'
import { parseSecretNames, splitManagedEnvironment, staleManagedSecrets, withSecretsFile } from './managed-secrets'
import { buildPlan, type CloudflareStep, findMigratableDatabases } from './plan'
import { CLOSED_ENVIRONMENT_FLAGS, createCloudflareProxyWorker, IamApplicationReference, PROXY_MANIFEST_DEFINE, proxyManifestJson } from './proxy'
import { CHECKOUT_INSTALL_ARGS, type RunnerApprovedAccess } from './runner-protocol'
import { defaultReconcileSchema } from './schema'
import { type AssetMount, assetMounts, SPA_ASSETS, SPA_ASSETS_DIRECTORY, stageSpaAssets } from './spa-assets'

const CANCELLED = 'deploy cancelled'

/** Every credential the platform hands the executor. The checkout's own build step must inherit none of them. */
const PLATFORM_CREDENTIAL_NAMES: readonly string[] = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'FABRIKA_IAM_PROVISIONING_KEY']

/**
 * What the checkout's build step gets of the run's values, over what it inherits: the secrets and vars the checkout's
 * config declares and the managed environment, as the runner once handed them through the executor's environment. An
 * undeclared name a secret's author chose never reaches it, and no value replaces a platform credential name.
 */
const buildEnvironment = (run: CloudflareDeployRun): Record<string, string> => {
	const env: Record<string, string> = {}
	for (const [name, value] of Object.entries(run.secrets)) env[name] = value
	for (const [name, value] of Object.entries(run.vars)) env[name] = value
	for (const name of Object.keys(run.managedEnvironment)) {
		const value = managedValue(run.managedEnvironment, name)
		if (value !== null) env[name] = value
	}
	for (const name of PLATFORM_CREDENTIAL_NAMES) delete env[name]
	return env
}

const workerDir = (config: CloudflareAppConfig, cwd: string): string => resolve(cwd, config.pipeline?.workerDir ?? '.')

/** The KV namespace oblaka keeps deploy state in. One definition, so the check and the call cannot drift. */
// An empty CLOUDFLARE_STATE_NAMESPACE means unset, never an empty oblaka state namespace.
const stateNamespace = (config: CloudflareAppConfig, run: CloudflareDeployRun): string =>
	run.stateNamespace === undefined || run.stateNamespace === '' ? `${config.id}-state` : run.stateNamespace

const wranglerEnv = (credentials: CloudflareCredentials): Record<string, string> => ({
	CLOUDFLARE_API_TOKEN: credentials.apiToken,
	CLOUDFLARE_ACCOUNT_ID: credentials.accountId,
})

const commandError = (label: string, result: { exitCode: number; stdout: string; stderr: string }): Error => {
	const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(0, 2000)
	return new Error(`${label} failed (exit ${result.exitCode}): ${detail}`)
}

const assertRunning = (signal: AbortSignal): void => {
	if (signal.aborted) {
		throw new Error(CANCELLED)
	}
}

/** What composing an application's Worker graph reads of a run; a local run (`composeLocalApplication`) supplies it too. */
type ApplicationTarget = Pick<
	CloudflareDeployRun,
	'appId' | 'env' | 'domain' | 'crossOrigins' | 'operationsOrigin' | 'iamService' | 'managedEnvironment' | 'vars' | 'secrets' | 'applicationObjects'
>

/** The bindings the platform writes into a contract application's Worker (ADR-0065). */
const PLATFORM_BINDINGS: ReadonlySet<string> = new Set([CLOUDFLARE_APPLICATION_BINDING, CLOUDFLARE_FILES_BINDING])

/** An application never names a variable only the platform writes, whether or not this deploy writes it. */
const assertNoFrameworkVariables = (config: CloudflareAppConfig, application: Worker, run: ApplicationTarget): void => {
	const authored = [
		...(config.pipeline?.vars ?? []),
		...(config.pipeline?.secrets ?? []),
		...Object.keys(application.options.vars ?? {}),
		...Object.keys(application.options.bindings ?? {}),
		...Object.keys(run.vars),
		...Object.keys(run.secrets),
	]
	const reserved = authored.find((name) => isFrameworkVariableName(name) || PLATFORM_BINDINGS.has(name))
	if (reserved !== undefined) {
		throw new Error(`cloudflare: application variable \`${reserved}\` is managed by Fabrika`)
	}
	if (application.options.triggers !== undefined) {
		throw new Error(`cloudflare: application Worker \`${application.options.name}\` sets \`triggers\`; the platform writes its cron triggers`)
	}
}

/**
 * Write the managed values into the application Worker: the public ones as vars, and the credentials as Worker secrets
 * the deploy uploads with the version (`withSecretsFile`), never as plain text in a generated config.
 */
const withManagedEnvironment = (
	config: CloudflareAppConfig,
	authored: Worker,
	run: ApplicationTarget,
	managed: ProviderManagedEnvironment,
): { readonly worker: Worker; readonly secrets: Readonly<Record<string, string>> } => {
	const declared = new Set([...(config.pipeline?.vars ?? []), ...(config.pipeline?.secrets ?? [])])
	const application = applicationWorker(authored)
	for (const name of Object.keys(managed)) {
		if (
			declared.has(name) || application.options.vars?.[name] !== undefined || run.vars[name] !== undefined || run.secrets[name] !== undefined
		) {
			throw new Error(`cloudflare: application variable \`${name}\` is managed by Fabrika`)
		}
	}
	const { vars, secrets } = splitManagedEnvironment(managed)
	if (Object.keys(vars).length === 0) return { worker: authored, secrets }
	const configured = new Worker({
		...application.options,
		vars: {
			...application.options.vars,
			...vars,
		},
	})
	return { worker: replaceApplicationWorker(authored, configured), secrets }
}

/** R2's bucket names: 3 to 63 lowercase letters, digits and hyphens, starting and ending with a letter or a digit. */
const R2_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/** The environment's files bucket, before oblaka's environment prefix. */
const filesBucketName = (appId: string): string => `${appId}-files`

/** The remote name oblaka gives the files bucket; it prefixes a bucket with the environment, `local` included. */
const filesBucketRemote = (run: ApplicationTarget): string => {
	const remote = `${run.env}-${filesBucketName(run.appId)}`
	if (!R2_BUCKET_NAME.test(remote)) {
		throw new Error(
			`cloudflare: the files bucket \`${remote}\` of \`${run.appId}@${run.env}\` is not a valid R2 bucket name; shorten the app id or the environment`,
		)
	}
	return remote
}

const MINUTE_TICK = '* * * * *'

/**
 * The hourly repair tick of an environment that serves alarms, at a minute derived from `<env>-<app>`: stable across
 * deploys, and spread so the fleet's environments do not all wake at once.
 */
const repairTick = (run: ApplicationTarget): string => {
	const minute = createHash('sha256').update(`${run.env}-${run.appId}`).digest().readUInt32BE(0) % 60
	return `${minute} * * * *`
}

/**
 * What the platform gives a contract application's Worker; the deployer writes exactly this and the bounds check it.
 * Only a release Control names serves alarms; a local deploy keeps the minute tick.
 */
const applicationRuntime = (run: ApplicationTarget, contract: ContractArtifact, entry: string | null, alarms: boolean): ApplicationRuntime => ({
	filesBucket: filesBucketRemote(run),
	crons: needsMinuteTick(contract) ? [alarms ? repairTick(run) : MINUTE_TICK] : [],
	entry,
})

/** Where the check step works: the application directory, beside its config and contract, and the config it reads. */
interface CheckTarget {
	readonly cwd: string
	readonly config: string
	/** The directory the runner installed the checkout's dependencies in; the CLI is looked for no higher. */
	readonly root: string
	/** The release pins the generated entry: after the tests the deploy reinstalls, regenerates it and checks it. */
	readonly regeneratesEntry: boolean
	/** The contract declares a table, so the application commits its schema types (`SCHEMA_TYPES_CHECK`). */
	readonly tables: boolean
}

/** The application's own CLI, where the checkout's `bun install` links it, as the Zerops build runs it. */
const APPLICATION_CLI = ['node_modules', '.bin', 'fabrika']

const ENTRY_BUILD_ARGS = ['app', 'build', '--provider=cloudflare']

/** The config the application CLI reads when it is named nothing else; an older `fabrika db` takes no `--config`. */
const DEFAULT_CONFIG = 'fabrika.config.ts'

/** All a checkout command gets of the executor's environment: what Bun needs to run. */
const ENTRY_BUILD_VARIABLES: readonly string[] = ['PATH', 'HOME', 'TMPDIR']

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isFile()
	} catch {
		return false
	}
}

/** The directories from the application directory up to `root`, where the CLI is looked for, nearest first. */
const cliSearchPath = ({ cwd, root }: CheckTarget): readonly string[] => {
	const dirs: string[] = []
	for (let dir = cwd; isWithin(root, dir); dir = dirname(dir)) {
		dirs.push(dir)
		if (dir === root) break
	}
	return dirs
}

/** The first `node_modules/.bin/fabrika` from the application directory up to `root`: a workspace links it at its root. */
const applicationCli = async (target: CheckTarget): Promise<string> => {
	const { cwd, root } = target
	for (const dir of cliSearchPath(target)) {
		const candidate = resolve(dir, ...APPLICATION_CLI)
		if (await isFile(candidate)) return candidate
	}
	throw new Error(
		`fabrika app build: no \`${APPLICATION_CLI.join('/')}\` from \`${cwd}\` up to \`${root}\`; the application installs \`@fabrika/cli\``,
	)
}

const isWithin = (root: string, dir: string): boolean => {
	const path = relative(root, dir)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/**
 * The executor holds the platform credentials in its environment and the run's application and managed secrets in
 * memory, and every check runs checkout code whose failed output reaches the log: it inherits nothing and gets only
 * `ENTRY_BUILD_VARIABLES`.
 */
const entryBuildEnvironment = (): { readonly env: Record<string, string>; readonly omitEnv: readonly string[] } => {
	const env: Record<string, string> = {}
	for (const name of ENTRY_BUILD_VARIABLES) {
		const value = process.env[name]
		if (value !== undefined) env[name] = value
	}
	return { env, omitEnv: Object.keys(process.env) }
}

/** What a failed check names: the check, as the step error says it. */
type CheckSubject = 'tests' | 'tsc' | 'fabrika-check' | 'schema types are stale'

/** The last 2,000 characters of a failed check's output: a test run or a type check reports its failures last. */
const checkError = (subject: CheckSubject, result: { exitCode: number; stdout: string; stderr: string }): Error => {
	const detail = (result.stderr.trim() || result.stdout.trim() || '(no output)').slice(-2000)
	return new Error(`check failed: ${subject} (exit ${result.exitCode}): ${detail}`)
}

/** One checkout command in `cwd`, with only what `entryBuildEnvironment` passes on. */
const runCheckoutCommand = async (
	cf: CloudflareCollaborators,
	run: CloudflareDeployRun,
	cwd: string,
	command: string,
	args: readonly string[],
): Promise<CommandResult> => {
	assertRunning(run.signal)
	return await cf.runCommand({ command, args: [...args], cwd, ...entryBuildEnvironment(), signal: run.signal })
}

/** Why the CLI of `release` cannot run the schema checks of the config `config`, or null when it can (ADR-0062). */
const schemaCheckGap = (release: string | undefined, config: string): string | null => {
	if (release === undefined || !checksSqliteSchema(release)) return `the CLI of framework ${release ?? '(unnamed)'} does not check a SQLite schema`
	if (config !== DEFAULT_CONFIG && !namesSchemaCheckConfig(release)) {
		return `the CLI of framework ${release} takes no \`--config\`, so it cannot read \`${config}\``
	}
	return null
}

/**
 * The Zerops build's order, for a run Control approved. The application's tests run first, and what they may leave
 * behind by accident is reinstalled, regenerated or written afresh after them; this does not stop a hostile test, since
 * Bun hardlinks installed files to its cache, so a dependency edited in place comes back with the reinstall. For a
 * release that pins the generated entry that is a frozen install into emptied `node_modules`, the entry (`fabrika app
 * build`), the platform tsconfig, then `tsc`, the checker and the schema checks; an older release keeps its authored
 * `main`, and only the checker follows, which reads no entry. The checker is the release Control approved the access
 * with; without one the step fails rather than deploy unchecked code.
 */
const runChecks = async (target: CheckTarget, run: CloudflareDeployRun, cf: CloudflareCollaborators): Promise<void> => {
	const checker = run.approved?.checker
	if (checker === undefined) {
		throw new Error(
			'check: Control named no `@fabrika/check` release for this run, so the application cannot be checked; upgrade Control to the release of its runner, then deploy again',
		)
	}
	const { tsconfig, checks: [tests, tsc, check] } = contractChecks(target.cwd, checker)
	const release = run.approved?.framework
	const gap = target.regeneratesEntry ? schemaCheckGap(release, target.config) : null
	const schema = target.regeneratesEntry && gap === null
	// An older `fabrika db` refuses any argument, so the default config is not named.
	const config = target.config === DEFAULT_CONFIG ? [] : [`--config=${target.config}`]
	const schemaTypes = schema && target.tables ? [...SCHEMA_TYPES_CHECK, ...config] : null
	const entryArgs = [...ENTRY_BUILD_ARGS, `--config=${target.config}`]
	if (run.dryRun) {
		const steps = target.regeneratesEntry
			? [
				tests.name,
				`bun ${CHECKOUT_INSTALL_ARGS.join(' ')} into an empty node_modules`,
				`fabrika ${entryArgs.join(' ')}`,
				tsc.name,
				check.name,
				...(schemaTypes === null ? [] : [`fabrika ${schemaTypes.join(' ')}`]),
			]
			: [tests.name, check.name]
		run.log(`  [dry-run] would run the checks in ${target.cwd}: ${steps.join(', ')}`)
		return
	}
	const shell = async (step: ContractCheck): Promise<void> => {
		const result = await runCheckoutCommand(cf, run, target.cwd, 'sh', ['-c', step.command])
		if (result.exitCode !== 0) throw checkError(step.name, result)
	}
	await shell(tests)
	if (!target.regeneratesEntry) {
		await shell(check)
		return
	}
	// Every `node_modules` the CLI is looked for in, so none the tests left on the way wins the lookup.
	for (const dir of cliSearchPath(target)) await rm(resolve(dir, 'node_modules'), { recursive: true, force: true })
	const installed = await runCheckoutCommand(cf, run, target.root, 'bun', CHECKOUT_INSTALL_ARGS)
	if (installed.exitCode !== 0) throw commandError(`bun ${CHECKOUT_INSTALL_ARGS.join(' ')}`, installed)
	const cli = await applicationCli(target)
	const built = await runCheckoutCommand(cf, run, target.cwd, cli, entryArgs)
	if (built.exitCode !== 0) throw commandError('fabrika app build', built)
	// Written afresh, so a file or link the tests left under that name is never what `tsc` reads or what is written through.
	const tsconfigPath = resolve(target.cwd, tsconfig.write)
	await mkdir(dirname(tsconfigPath), { recursive: true })
	await rm(tsconfigPath, { force: true })
	await writeFile(tsconfigPath, `${tsconfig.lines.join('\n')}\n`, { flag: 'wx' })
	await shell(tsc)
	await shell(check)
	if (gap !== null) {
		run.log(`  ${gap}; the schema types are not checked`)
		return
	}
	if (schemaTypes === null) {
		run.log('  the contract declares no table, so there are no schema types to check')
		return
	}
	const result = await runCheckoutCommand(cf, run, target.cwd, cli, schemaTypes)
	if (result.exitCode !== 0) throw checkError('schema types are stale', result)
}

/**
 * Every secret `pipeline.secrets` declares that the run has no value for, refused before any step runs: found in
 * `sync-secrets`, it would fail the run after `deploy-worker` had shipped a Worker without it. Names only, never a value.
 */
const assertDeclaredSecrets = (config: CloudflareAppConfig, run: CloudflareDeployRun, platformResources: 'refuse' | 'allow'): void => {
	// An own property only: `constructor` or `toString` would otherwise read as set.
	const missing = [...new Set(config.pipeline?.secrets ?? [])].filter((name) => {
		if (!Object.hasOwn(run.secrets, name)) return true
		const value: unknown = run.secrets[name]
		return typeof value !== 'string' || value === ''
	})
	if (missing.length === 0) return
	const names = missing.map((name) => `\`${name}\``).join(', ')
	const where = platformResources === 'allow' ? "in the deploy's environment" : 'in the console'
	const declared = `declared in ${basename(run.configPath)}`
	throw new Error(
		missing.length === 1
			? `cloudflare: secret ${names} is ${declared} but has no value on environment \`${run.env}\`; set it ${where} before deploying`
			: `cloudflare: secrets ${names} are ${declared} but have no value on environment \`${run.env}\`; set them ${where} before deploying`,
	)
}

/**
 * The objects of a release that serves ops (ADR-0069) when Control names none: ordinary traffic reaches `application`,
 * and ops requests reach it and the object a backup is rehearsed in (ADR-0070).
 */
const DEFAULT_OBJECTS: ApplicationObjects = { object: DEFAULT_APPLICATION_OBJECT, objects: [DEFAULT_APPLICATION_OBJECT, OPS_REHEARSAL_OBJECT] }

/** The object variables written from the pointer Control records, so a deploy keeps one a side restore moved (ADR-0070 §9). */
const objectVariables = (objects: ApplicationObjects): Readonly<Record<string, string>> => ({
	[FABRIKA_APPLICATION_OBJECT]: objects.object,
	[FABRIKA_APPLICATION_OBJECTS]: objects.objects.join(','),
})

/**
 * Bind the application's Durable Object, which runs the application over its SQLite, the environment's files bucket,
 * and its cron trigger (ADR-0065), and on a release that serves ops name its objects. The object is bound first, so
 * oblaka numbers its migration `v0001` whatever else the application binds, and the tag never moves. With `assets`,
 * the Worker also gets the Workers Assets the deploy stages the mounts' files into (`SPA_ASSETS`).
 */
const withApplicationRuntime = (
	authored: Worker,
	run: ApplicationTarget,
	runtime: ApplicationRuntime,
	ops: boolean,
	assets: boolean,
): Worker => {
	const application = applicationWorker(authored)
	const configured = new Worker({
		...application.options,
		...(ops ? { vars: { ...application.options.vars, ...objectVariables(run.applicationObjects ?? DEFAULT_OBJECTS) } } : {}),
		...(assets ? { assets: { ...SPA_ASSETS } } : {}),
		bindings: {
			[CLOUDFLARE_APPLICATION_BINDING]: new DurableObject({ name: `${run.appId}-application`, className: CLOUDFLARE_APPLICATION_CLASS }),
			...application.options.bindings,
			[CLOUDFLARE_FILES_BINDING]: new R2Bucket({ name: filesBucketName(run.appId) }),
		},
		// Always written: wrangler leaves a Worker's schedules alone when `triggers` is absent, and clears them on `[]`.
		triggers: { crons: [...runtime.crons] },
	})
	return replaceApplicationWorker(authored, configured)
}

/**
 * Keep the Worker's environment out of module scope (`CLOSED_ENVIRONMENT_FLAGS`). Under `nodejs_compat` from
 * compatibility date 2025-04-01, or with `nodejs_compat_populate_process_env`, workerd fills `process.env` at module
 * evaluation with every text variable and secret, the framework's included, before the object's boot captures them
 * (`nodejs_compat_v2` alone leaves it empty); and the `env` of `cloudflare:workers` is every binding unless
 * `disallow_importable_env` is set (measured in workerd 1.20260312.1). The platform therefore always adds each opt-out,
 * and refuses an authored opt-in.
 */
const withoutProcessEnvironment = (authored: Worker): Worker => {
	const application = applicationWorker(authored)
	const flags = application.options.compatibility_flags ?? []
	for (const { opened, what } of CLOSED_ENVIRONMENT_FLAGS) {
		if (flags.includes(opened)) {
			throw new Error(
				`cloudflare: application Worker \`${application.options.name}\` sets \`${opened}\`, which would put the platform's secrets in ${what}; drop it and read the application's own values through the framework`,
			)
		}
	}
	const missing = CLOSED_ENVIRONMENT_FLAGS.map(({ closed }) => closed).filter((closed) => !flags.includes(closed))
	if (missing.length === 0) return authored
	return replaceApplicationWorker(authored, new Worker({ ...application.options, compatibility_flags: [...flags, ...missing] }))
}

/** The proxy Worker the platform builds for application `appId`, before oblaka's environment prefix. */
const proxyWorkerName = (appId: string): string => `${appId}-proxy`

/** The remote name oblaka gives a Worker named `name` in `env`. */
const remoteName = (env: string, name: string): string => (env === 'local' ? name : `${env}-${name}`)

/**
 * Each connector import's `FABRIKA_CONNECT_<IMPORT>` service binding, to the owner's proxy Worker in the same
 * environment, by binding name; the owner's proxy enforces the export (ADR-0022), so no binding reaches its application.
 */
const connectorBindings = (contract: ContractArtifact | null): Readonly<Record<string, string>> =>
	Object.fromEntries(
		Object.entries(contract?.imports ?? {}).map(([name, imported]) => [connectVariables(name).binding, proxyWorkerName(imported.app)]),
	)

/** The application Worker's `IAM` binding, written by the deployer so that it names this deployment (ADR-0067 §3). */
const withIamIdentity = (authored: Worker, iamAppId: string, iamService: string | undefined): Worker => {
	const application = applicationWorker(authored)
	const declared = application.options.bindings?.['IAM']
	// A skipped binding or a resource under the name is no IAM binding; oblaka provisions it, and the bounds check whatever it emits.
	if (!declared || 'getId' in declared) return authored
	const configured = new Worker({
		...application.options,
		bindings: { ...application.options.bindings, IAM: new IamApplicationReference(iamAppId, 'application', declared, iamService) },
	})
	return replaceApplicationWorker(authored, configured)
}

const withConnectorBindings = (authored: Worker, bindings: Readonly<Record<string, string>>): Worker => {
	if (Object.keys(bindings).length === 0) return authored
	const application = applicationWorker(authored)
	const configured = new Worker({
		...application.options,
		bindings: {
			...application.options.bindings,
			...Object.fromEntries(Object.entries(bindings).map(([binding, worker]) => [binding, new ServiceReference(worker)])),
		},
	})
	return replaceApplicationWorker(authored, configured)
}

/** The contract a deployment serves, and the digest the application's own framework release computes for it. */
interface ServedContract {
	readonly contract: ContractArtifact
	readonly digest: string
}

/**
 * A contract application starts only as the contract it was deployed with (ADR-0022 rule 5), so the platform writes its
 * digest. Control never hands one: `parseManagedEnvironment` refuses the name.
 */
const contractEnvironment = (managed: ProviderManagedEnvironment, served: ServedContract | null): ProviderManagedEnvironment => {
	if (served === null) return managed
	return { ...managed, [FABRIKA_CONTRACT_DIGEST]: { value: served.digest, credential: isManagedCredential(FABRIKA_CONTRACT_DIGEST) } }
}

/**
 * The lock-down follows the contract, not the config: a contract whose IAM schema does not say `contract: true`, or a
 * platform service's schema that does, would leave the proxy and IAM deciding under different rules. An application
 * (`refuse`) may declare no schema, because Control writes the approved contract's own (ADR-0050); a platform deploy
 * (`allow`) registers the schema itself (ADR-0058), so it must declare one.
 */
const assertContractSchema = (schema: AppSchema | null, contract: ContractArtifact | null, platformResources: 'refuse' | 'allow'): void => {
	const declared = schema?.contract === true
	if (contract === null && declared) {
		throw new Error('cloudflare: the IAM schema says `contract: true`, but the checkout has no `fabrika.contract.ts`')
	}
	if (contract !== null && !declared && (schema !== null || platformResources === 'allow')) {
		throw new Error('cloudflare: this deployment serves a contract, so its IAM schema is `schemaFromContract(artifact)` (`contract: true`)')
	}
}

/**
 * The proxy Worker is the platform's (ADR-0048): built here, from this package's own entrypoint, around the
 * application Worker the config returns, never taken from the checkout. A config that returns a proxy is refused.
 * `ops` adds Control's ops row to the table.
 */
const platformProxied = (authored: Worker, served: ServedContract, run: ApplicationTarget, ops: boolean): Worker => {
	if (authored.options.bindings?.['APP']) {
		throw new Error(
			`cloudflare: \`resources\` returns the Worker \`${authored.options.name}\` binding \`APP\`, a proxy of its own; return the application Worker, and the platform builds the proxy Worker from its contract`,
		)
	}
	const name = proxyWorkerName(run.appId)
	if (authored.options.name === name) {
		throw new Error(`cloudflare: application Worker \`${name}\` takes the name of the proxy Worker the platform builds; rename it`)
	}
	return createCloudflareProxyWorker({
		name,
		app: authored,
		appId: appEnvironmentId(run.appId, run.env),
		appHost: run.domain ?? 'localhost',
		...(run.domain === undefined ? {} : { domain: run.domain }),
		...(run.crossOrigins === undefined ? {} : { crossOrigins: run.crossOrigins }),
		endpoints: contractProxyTable(served.contract, served.digest, { ops }),
		...operationsOrigin(run),
		...(run.iamService === undefined ? {} : { iamRemoteService: run.iamService }),
		iamUrl: managedValue(run.managedEnvironment, FABRIKA_IAM_ISSUER) ?? '',
	})
}

/** The origin of the environment's Operations ingest, which the proxy's `connect-src` admits, as the framework's does. */
const operationsOrigin = (run: ApplicationTarget): { readonly operationsOrigin?: string } => {
	if (run.operationsOrigin !== undefined) return { operationsOrigin: run.operationsOrigin }
	// A job from an older Control names no origin; derive it from the DSN until no release in the window omits it.
	const dsn = managedValue(run.managedEnvironment, 'FABRIKA_OPERATIONS_DSN')
	if (dsn === null) return {}
	let origin: string
	try {
		origin = new URL(dsn).origin
	} catch {
		origin = ''
	}
	// The DSN carries the ingest key, so the message names the variable and never its value.
	if (!isPolicyOrigin(origin, ['https:', 'http:'])) throw new Error('cloudflare: FABRIKA_OPERATIONS_DSN is not an http(s) URL with a literal host')
	return { operationsOrigin: origin }
}

const applicationWorker = (worker: Worker): Worker => {
	const child = worker.options.bindings?.['APP']
	return child instanceof Worker ? applicationWorker(child) : worker
}

const replaceApplicationWorker = (worker: Worker, replacement: Worker): Worker => {
	const child = worker.options.bindings?.['APP']
	if (!(child instanceof Worker)) return replacement
	return new Worker({
		...worker.options,
		bindings: {
			...worker.options.bindings,
			APP: replaceApplicationWorker(child, replacement),
		},
	})
}

const databaseOwnerDir = (worker: Worker, binding: string, rootDir: string): string => {
	const parts = binding.split('.')
	let current = worker
	for (let index = 0; index < parts.length - 1; index++) {
		const part = parts[index]
		if (part === undefined) return rootDir
		const child = current.options.bindings?.[part]
		if (!(child instanceof Worker)) return rootDir
		current = child
	}
	return resolve(rootDir, current.options.dir)
}

const migrationBinding = (binding: string): string => {
	const parts = binding.split('.')
	return parts[parts.length - 1] ?? binding
}

interface StepEnv {
	readonly config: CloudflareAppConfig
	/** The IAM schema read before the checkout's `resources()` ran (`configSchema`). */
	readonly schema: AppSchema | null
	readonly run: CloudflareDeployRun
	readonly credentials: CloudflareCredentials
	readonly worker: Worker
	readonly dir: string
	readonly cf: CloudflareCollaborators
	readonly platformResources: 'refuse' | 'allow'
	readonly platformIam: PlatformIamTarget | undefined
	readonly reconcileSchema: SchemaReconciler
	readonly bounds: DeploymentBounds
	/** The managed credentials the application Worker's version is uploaded with, as Worker secrets. */
	readonly managedSecrets: Readonly<Record<string, string>>
	/** What the check step checks: an application deploy Control approved; null for a local or a platform deploy. */
	readonly checks: CheckTarget | null
	/**
	 * The mounts whose files the deploy stages into the application Worker's assets, from the application's root; null
	 * when the Worker declares its own `assets` or no mount serves files.
	 */
	readonly spaAssets: { readonly mounts: readonly AssetMount[]; readonly root: string } | null
	generatedConfigs: readonly GeneratedConfig[]
}

/**
 * `wrangler deploy`, with the managed secrets uploaded in the same version when there are any, so the version never
 * serves without them, and a plain var of the same name an older release wrote goes with the old version.
 */
const wranglerDeploy = async (env: StepEnv, cwd: string, secrets: Readonly<Record<string, string>>): Promise<void> => {
	const { run, credentials, cf } = env
	const names = Object.keys(secrets)
	if (run.dryRun) {
		run.log(`  [dry-run] would run: wrangler deploy${names.length === 0 ? '' : ` with the secrets ${names.join(', ')}`} in ${cwd}`)
		return
	}
	assertRunning(run.signal)
	await withSecretsFile(secrets, async (path) => {
		const args = path === null ? ['deploy'] : ['deploy', '--secrets-file', path]
		const result = await cf.runCommand({ command: 'wrangler', args, cwd, env: wranglerEnv(credentials), signal: run.signal })
		if (result.exitCode !== 0) throw commandError('wrangler deploy', result)
	})
}

/** Refuse a Custom Domain of `generated` that another Worker or a DNS record holds, before wrangler would take it over. */
const assertOwnedDomains = async (env: StepEnv, generated: GeneratedConfig): Promise<void> => {
	const hostnames = customDomainHosts(generated.config)
	if (hostnames.length === 0) return
	const script = generated.config.name ?? ''
	if (env.run.dryRun) {
		env.run.log(`  [dry-run] would check that no other Worker or DNS record holds ${hostnames.join(', ')}`)
		return
	}
	assertRunning(env.run.signal)
	const { accountId, apiToken } = env.credentials
	await assertCustomDomainsOwned({ accountId, apiToken, fetch: env.cf.cloudflareApi, signal: env.run.signal }, script, hostnames)
}

/** Delete the framework secrets the application Worker holds that this deploy no longer writes, as Zerops removes them. */
const deleteStaleSecrets = async (env: StepEnv, cwd: string): Promise<void> => {
	const { run, credentials, cf } = env
	if (run.dryRun) {
		run.log(`  [dry-run] would delete the managed secrets this deploy no longer writes in ${cwd}`)
		return
	}
	assertRunning(run.signal)
	const listed = await cf.runCommand({
		command: 'wrangler',
		args: ['secret', 'list', '--format', 'json'],
		cwd,
		env: wranglerEnv(credentials),
		signal: run.signal,
	})
	if (listed.exitCode !== 0) throw commandError('wrangler secret list', listed)
	for (const name of staleManagedSecrets(parseSecretNames(listed.stdout), env.managedSecrets)) {
		assertRunning(run.signal)
		// A piped stdin keeps wrangler non-interactive, so its confirmation takes its fallback answer.
		const result = await cf.runCommand({
			command: 'wrangler',
			args: ['secret', 'delete', name],
			cwd,
			env: wranglerEnv(credentials),
			stdin: '',
			signal: run.signal,
		})
		if (result.exitCode !== 0) throw commandError(`wrangler secret delete ${name}`, result)
		run.log(`  deleted the managed secret ${name}, which this deploy no longer writes`)
	}
}

/** Stage the mounts' files beside the application Worker's generated config, where its `assets.directory` points. */
const stageAssets = async (env: StepEnv, assets: NonNullable<StepEnv['spaAssets']>, generatedDir: string): Promise<void> => {
	const mounts = assets.mounts.map((mount) => `${mount.prefix} from ${mount.dir}`).join(', ')
	if (env.run.dryRun) {
		env.run.log(`  [dry-run] would stage the SPA files into ${SPA_ASSETS_DIRECTORY}: ${mounts}`)
		return
	}
	assertRunning(env.run.signal)
	const staged = await stageSpaAssets(assets.mounts, assets.root, generatedDir)
	env.run.log(`  staged ${staged} SPA files into ${SPA_ASSETS_DIRECTORY}: ${mounts}`)
}

/**
 * The secrets stored for the environment that `fabrika.config.ts` does not name in `pipeline.secrets`, by name. The deploy
 * writes only declared ones, so these never reach the Worker; the run log says so, as an author would otherwise wonder.
 */
export const undeclaredSecrets = (config: CloudflareAppConfig, run: Pick<CloudflareDeployRun, 'secrets'>): string[] => {
	const declared = new Set(config.pipeline?.secrets ?? [])
	return Object.keys(run.secrets).filter((name) => !declared.has(name)).sort()
}

const runStep = async (spec: CloudflareStep, env: StepEnv): Promise<void> => {
	const { config, run, credentials, worker, dir, cf } = env
	const { signal, dryRun } = run

	switch (spec.kind) {
		case 'build': {
			const build = config.pipeline?.build
			if (build !== undefined && dryRun) {
				run.log(`  [dry-run] would run build: \`${build}\` in ${dir}`)
			} else if (build !== undefined) {
				assertRunning(signal)
				const result = await cf.runCommand({
					command: 'sh',
					args: ['-c', build],
					cwd: dir,
					env: buildEnvironment(run),
					omitEnv: PLATFORM_CREDENTIAL_NAMES,
					signal,
				})
				if (result.exitCode !== 0) throw commandError(`build (\`${build}\`)`, result)
			}
			return
		}
		case 'check': {
			if (env.checks === null) throw new Error('check: the deploy checks only an application deploy Control approved')
			await runChecks(env.checks, run, cf)
			return
		}
		case 'provision-resources': {
			assertRunning(signal)
			const result = await cf.provision({
				definition: worker,
				accountId: credentials.accountId,
				apiToken: credentials.apiToken,
				env: run.env,
				cwd: dir,
				stateNamespace: stateNamespace(config, run),
				dryRun,
			})
			env.generatedConfigs = result.wranglerConfigs
			const names = result.wranglerConfigs.map((item) => item.config.name ?? '(unnamed)').join(', ')
			run.log(dryRun ? `  [dry-run] provisioned (plan-only): ${names}` : `  provisioned: ${names}`)
			return
		}
		case 'migrate': {
			const binding = spec.id.slice('migrate:'.length)
			const database = findMigratableDatabases(worker).find((item) => item.binding === binding)
			if (database === undefined) throw new Error(`migrate: no migratable D1 database for binding \`${binding}\``)
			const commandBinding = migrationBinding(database.binding)
			const migrationDir = databaseOwnerDir(worker, database.binding, dir)
			if (dryRun) {
				run.log(`  [dry-run] would run: wrangler d1 migrations apply ${commandBinding} --remote in ${migrationDir}`)
				return
			}
			assertRunning(signal)
			const result = await cf.runCommand({
				command: 'wrangler',
				args: ['d1', 'migrations', 'apply', commandBinding, '--remote'],
				cwd: migrationDir,
				env: wranglerEnv(credentials),
				signal,
			})
			if (result.exitCode !== 0) throw commandError(`wrangler d1 migrations apply ${commandBinding}`, result)
			return
		}
		case 'deploy-worker': {
			for (const name of undeclaredSecrets(config, run)) {
				run.log(`  the secret ${name} is stored for this environment but not named in pipeline.secrets, so the Worker does not get it`)
			}
			const configs = env.generatedConfigs
			// The configs oblaka wrote, not the generation checked before the run: a stateful binding can emit differently twice.
			assertGeneratedConfigs(configs, env.bounds)
			if (configs.length === 0) {
				await wranglerDeploy(env, dir, env.managedSecrets)
				return
			}
			// An application's deploy takes no hostname another Worker or a DNS record holds, which wrangler would take over;
			// checked before any Worker deploys, so a refusal leaves the environment as it was.
			if (env.platformResources === 'refuse') { for (const generated of configs) await assertOwnedDomains(env, generated) }
			const application = `${run.env}-${applicationWorker(worker).options.name}`
			let applicationDir: string | undefined
			for (const generated of deployOrder(configs)) {
				const generatedDir = dirname(resolve(dir, generated.path))
				const isApplication = generated.config.name === application
				// The checkout's build has written the mounts' directories; the walk below checks the staged copy.
				if (isApplication && env.spaAssets !== null) await stageAssets(env, env.spaAssets, generatedDir)
				// The checkout's own build step has run by now, so this is the last moment the tree is still ours to check.
				if (env.platformResources === 'refuse') await assertLiteralAssets(generated, generatedDir)
				await wranglerDeploy(env, generatedDir, isApplication ? env.managedSecrets : {})
				if (isApplication) applicationDir = generatedDir
			}
			// Swept only once every Worker is deployed: a failed sweep must not leave the new application behind the old proxy.
			// A platform component's own secrets carry framework names (IAM's mail transport), so only an application's are swept.
			if (applicationDir !== undefined && env.platformResources === 'refuse') await deleteStaleSecrets(env, applicationDir)
			return
		}
		case 'reconcile-schema': {
			const schema = env.schema
			if (schema === null) return
			const returnOrigins = run.returnOrigins !== undefined && run.returnOrigins.length > 0 ? run.returnOrigins : undefined
			if (dryRun) {
				run.log(
					env.platformResources === 'allow'
						? `  [dry-run] would reconcile the authz schema for \`${config.id}\` with IAM`
						: `  [dry-run] would report the authz schema for \`${config.id}\` to the control plane`,
				)
				if (returnOrigins !== undefined) {
					run.log(`  [dry-run] would register return origins for \`${config.id}\`: ${returnOrigins.join(', ')}`)
				}
				return
			}
			assertRunning(signal)
			// The installation deploying its own component holds IAM's provisioning key and registers the schema itself.
			if (env.platformResources === 'allow') {
				if (env.platformIam === undefined) {
					throw new Error('reconcile-schema: a platform deploy registers its schema with IAM; set FABRIKA_IAM_ISSUER and FABRIKA_IAM_PROVISIONING_KEY')
				}
				await env.reconcileSchema({
					url: env.platformIam.url,
					app: config.id,
					schema,
					...(returnOrigins === undefined ? {} : { returnOrigins }),
					adminKey: env.platformIam.adminKey,
					signal,
				})
				return
			}
			// The reconcile itself happens in the CONTROL plane, which holds IAM's admin key; this
			// container runs the checkout's own code and never sees it (ADR-0022).
			await cf.writeOutcome({ iamReconcile: { app: config.id, schemaJson: JSON.stringify(schema) } })
			return
		}
		case 'sync-secrets': {
			const secretsDir = resolve(dir, applicationWorker(worker).options.dir)
			for (const name of config.pipeline?.secrets ?? []) {
				const value = run.secrets[name]
				// Unreachable after `assertDeclaredSecrets`; kept so this step never pipes an absent value.
				if (value === undefined) throw new Error(`sync-secrets: missing value for secret \`${name}\` (not in run.secrets)`)
				if (dryRun) {
					run.log(`  [dry-run] would run: wrangler secret put ${name} (value piped from run.secrets)`)
					continue
				}
				assertRunning(signal)
				const result = await cf.runCommand({
					command: 'wrangler',
					args: ['secret', 'put', name],
					cwd: secretsDir,
					env: wranglerEnv(credentials),
					stdin: value,
					signal,
				})
				if (result.exitCode !== 0) throw commandError(`wrangler secret put ${name}`, result)
			}
			return
		}
	}
}

type CloudflareCredentials = Pick<CloudflareDeployerOptions, 'accountId' | 'apiToken'>

export interface CloudflareDeployerOptions {
	readonly accountId: string
	readonly apiToken: string
	readonly collaborators?: CloudflareCollaborators
	/**
	 * `refuse` (the default) rejects a config that names one of fabrika's own resources. Only the
	 * operator deploying fabrika itself passes `allow`; a checkout is never trusted with it.
	 */
	readonly platformResources?: 'refuse' | 'allow'
	/** Where a platform deploy (`allow`) registers a component's schema. Never set for an application deploy. */
	readonly platformIam?: PlatformIamTarget
	/** Replaces the HTTP reconcile with IAM (tests). */
	readonly reconcileSchema?: SchemaReconciler
}

/** IAM's origin and the installation's provisioning key, as the installation's own deploy holds them. */
export interface PlatformIamTarget {
	readonly url: string
	readonly adminKey: string
}

export interface CloudflareDeployRun {
	readonly appId: string
	readonly env: string
	readonly domain?: string
	/** The environment's cross-origin list from Control's registry (ADR-0022); the proxy Worker's manifest entry lists it. */
	readonly crossOrigins?: readonly string[]
	/** The origin of the environment's Operations ingest, from Control; the proxy Worker's `connect-src` admits it. */
	readonly operationsOrigin?: string
	/** Every origin IAM may hand this environment a session at, registered under `<app>@<env>`. */
	readonly returnOrigins?: readonly string[]
	readonly cwd: string
	readonly configPath: string
	readonly stateNamespace?: string
	readonly secrets: Readonly<Record<string, string>>
	readonly vars: Readonly<Record<string, string>>
	/** Platform-owned runtime configuration, separate from operator-managed application vars. */
	readonly managedEnvironment: ProviderManagedEnvironment
	/**
	 * The contract Control approved for this run (ADR-0050), with the digest the application's release computes. Absent
	 * outside Control (a local deploy), the deployer reads `fabrika.contract.ts` from the checkout, as Control does.
	 */
	readonly approved?: RunnerApprovedAccess
	/** Every Cloudflare deployment of the installation in Control's registry; a name of another application is refused. */
	readonly installationApps?: readonly AppEnvironment[]
	/**
	 * IAM's Worker by its remote name, as Control names the installation's; the application and its proxy bind it whatever
	 * env they deploy in. Absent (a local deploy, an older Control), they bind `${env}-propustka-worker`.
	 */
	readonly iamService?: string
	/** The serving object and the listed objects Control records (ADR-0070 §9); absent, `application` and `rehearsal`. */
	readonly applicationObjects?: ApplicationObjects
	readonly dryRun: boolean
	readonly signal: AbortSignal
	readonly log: (line: string) => void
}

export interface CloudflareDeployResult {
	readonly appId: string
	readonly env: string
	readonly status: 'succeeded' | 'failed'
	readonly steps: readonly DeployStepResult[]
}

const servedContract = async (
	cf: CloudflareCollaborators,
	cwd: string,
	approved: RunnerApprovedAccess | undefined,
): Promise<ServedContract | null> => {
	if (approved !== undefined) return { contract: approved.contract, digest: approved.contractDigest }
	const read = await cf.readContract(cwd)
	return read === null ? null : { contract: read, digest: contractDigest(read) }
}

export const createCloudflareDeployer = (options: CloudflareDeployerOptions) => async (run: CloudflareDeployRun): Promise<CloudflareDeployResult> => {
	const cf = options.collaborators ?? defaultCloudflareCollaborators
	const loaded = await cf.loadConfig(run.cwd, run.configPath)
	if (loaded.config.id !== run.appId) {
		throw new Error(`Cloudflare config declares app "${loaded.config.id}", expected "${run.appId}"`)
	}
	const platformResources = options.platformResources ?? 'refuse'
	assertDeclaredSecrets(loaded.config, run, platformResources)
	const served = await servedContract(cf, loaded.cwd, run.approved)
	const contract = served?.contract ?? null
	// Fabrika's own components (`allow`) are its trusted installation path; an application needs a contract.
	if (platformResources === 'refuse' && served === null) {
		throw new Error('cloudflare: the checkout has no `fabrika.contract.ts`; Fabrika deploys an application only with a contract')
	}
	// A local deploy reads the contract with this release and runs it in the object, so it is gated as this release is.
	const framework = run.approved === undefined ? undefined : run.approved.framework
	const gates = run.approved === undefined
		? { capsSegments: true, servesSql: true }
		: { capsSegments: framework !== undefined && capsJobSegments(framework), servesSql: framework !== undefined && servesRawSql(framework) }
	if (platformResources === 'refuse' && contract !== null) assertCloudflareContract(contract, gates)
	// Read once, before `resources()` runs the checkout's code again: nothing below reads the config's schema.
	const schema = configSchema(loaded.config)
	assertContractSchema(schema, contract, platformResources)
	const authored = runnerWorkerGraph(loaded.config.resources({ env: run.env, domain: run.domain }))
	// Only a release Control named pins the entry or serves ops; a local deploy names none and keeps its authored `main`.
	const release = run.approved?.framework
	const opsRelease = release !== undefined && servesOps(release)
	// Fabrika's own components compose their own proxies; every application gets the platform's. Without a domain no
	// Custom Domain carries the ops channel, so the proxy gets no ops row (ADR-0069).
	const proxied = platformResources === 'refuse' && served !== null
		? platformProxied(authored, served, run, opsRelease && run.domain !== undefined)
		: authored
	if (platformResources === 'refuse') assertNoFrameworkVariables(loaded.config, applicationWorker(proxied), run)
	const connectors = platformResources === 'refuse' ? connectorBindings(contract) : {}
	// An older release's entry exports no object, and a Control older than the runner names no release (ADR-0062).
	const objectRuntime = run.approved === undefined || (run.approved.framework !== undefined && runsInObject(run.approved.framework))
	const entry = release !== undefined && pinsGeneratedEntry(release) ? resolve(loaded.cwd, GENERATED_ENTRY_FILE) : null
	const alarms = release !== undefined && servesAlarms(release)
	const runtime = platformResources === 'refuse' && contract !== null && objectRuntime ? applicationRuntime(run, contract, entry, alarms) : null
	const managed = withManagedEnvironment(loaded.config, proxied, run, contractEnvironment(run.managedEnvironment, served))
	const identified = platformResources === 'refuse'
		? withIamIdentity(managed.worker, appEnvironmentId(run.appId, run.env), run.iamService)
		: managed.worker
	const connected = withConnectorBindings(identified, connectors)
	// An application Worker that declares its own `assets` keeps them; otherwise the platform stages the mounts' files.
	const mounts = runtime !== null && contract !== null ? assetMounts(contract) : []
	const spaAssets = mounts.length > 0 && applicationWorker(connected).options.assets === undefined ? { mounts, root: loaded.cwd } : null
	const composed = runtime === null ? connected : withApplicationRuntime(connected, run, runtime, opsRelease, spaAssets !== null)
	const worker = platformResources === 'refuse' ? withoutProcessEnvironment(composed) : composed
	const dir = workerDir(loaded.config, loaded.cwd)
	const bounds: DeploymentBounds = {
		env: run.env,
		...(run.domain === undefined ? {} : { domain: run.domain }),
		cwd: dir,
		platformResources,
		iamAppId: appEnvironmentId(run.appId, run.env),
		installation: run.installationApps ?? [],
		...(run.iamService === undefined ? {} : { iamService: run.iamService }),
		proxy: proxied === authored ? null : `${run.env}-${run.appId}-proxy`,
		connectors: Object.fromEntries(Object.entries(connectors).map(([binding, owner]) => [binding, remoteName(run.env, owner)])),
		frameworkVariables: {
			application: frameworkValues(applicationWorker(worker).options.vars),
			proxy: proxied === authored ? null : frameworkValues(worker.options.vars),
		},
		proxyManifest: proxied === authored ? null : (worker.options.define?.[PROXY_MANIFEST_DEFINE] ?? null),
		application: runtime,
	}
	assertStateNamespace(stateNamespace(loaded.config, run), platformResources)
	assertGeneration(await generateWranglerConfigs(worker, run.env), bounds)
	const env: StepEnv = {
		config: loaded.config,
		schema,
		run,
		credentials: { accountId: options.accountId, apiToken: options.apiToken },
		worker,
		dir,
		cf,
		platformResources,
		platformIam: options.platformIam,
		reconcileSchema: options.reconcileSchema ?? defaultReconcileSchema,
		bounds,
		managedSecrets: managed.secrets,
		// A local deploy and fabrika's own components are not checked: only a run Control approved names a checker.
		checks: platformResources === 'refuse' && run.approved !== undefined
			? {
				cwd: loaded.cwd,
				config: basename(resolve(run.cwd, run.configPath)),
				root: resolve(run.cwd),
				regeneratesEntry: runtime !== null && runtime.entry !== null,
				tables: Object.keys(run.approved.contract.tables).length > 0,
			}
			: null,
		spaAssets,
		generatedConfigs: [],
	}
	const result = await runSteps(buildPlan(loaded.config, worker, env.checks), run, (step) => runStep(step, env))
	return { appId: run.appId, env: run.env, ...result }
}

/** The SPA files `stageLocalAssets` staged for a local run: the mounts it copied, in the order a deploy stages them. */
export interface StagedLocalAssets {
	readonly mounts: readonly AssetMount[]
	readonly files: number
}

/**
 * Stage the contract's SPA and link mounts for a local run, with the code a deploy stages them with: each mount's
 * built directory under `root` into `root/fabrika/assets`, where the generated `wrangler.jsonc` beside the config points
 * its `ASSETS`. Run it before oblaka generates the config (`await` at the top of `oblaka.ts`) and after the SPA build.
 */
export const stageLocalAssets = async (contract: ContractArtifact, root: string): Promise<StagedLocalAssets> => {
	const mounts = assetMounts(contract)
	return { mounts, files: mounts.length === 0 ? 0 : await stageSpaAssets(mounts, root, root) }
}

const sameMounts = (left: readonly AssetMount[], right: readonly AssetMount[]): boolean =>
	left.length === right.length && left.every((mount, index) => mount.prefix === right[index]?.prefix && mount.dir === right[index]?.dir)

/** What `composeLocalApplication` needs: the config, the contract it serves, and the IAM a local run reaches. */
export interface LocalApplicationOptions {
	readonly config: CloudflareAppConfig
	readonly contract: ContractArtifact
	/** What `stageLocalAssets` staged; required when the contract has an SPA or link mount and the Worker no `assets`. */
	readonly assets?: StagedLocalAssets
	/** IAM's origin, the issuer of the local run's tokens. */
	readonly iamOrigin: string
	readonly env: string
	readonly domain?: string
	/**
	 * The key of every job, webhook and public procedure by its variable (`issueLocalWorkloadKeys`), which Control
	 * writes into a deploy. Without it the run supplies them itself (`.dev.vars`), or the application does not boot.
	 * They are written as plain vars, like the proxy secret, so the generated config must stay out of version control.
	 */
	readonly workloadKeys?: Readonly<Record<string, string>>
}

/** The local run's workload keys: exactly the contract's variables, each a `px_` key. */
const localWorkloadKeys = (contract: ContractArtifact, keys: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> => {
	if (keys === undefined) return {}
	const expected = localWorkloadKeyVariables(contract)
	const missing = expected.filter((name) => keys[name] === undefined)
	const unknown = Object.keys(keys).filter((name) => !expected.includes(name)).sort()
	if (missing.length > 0 || unknown.length > 0) {
		const named = [...missing.map((name) => `missing ${name}`), ...unknown.map((name) => `${name} names no workload of the contract`)]
		throw new Error(`composeLocalApplication: \`workloadKeys\` must hold the key of every workload: ${named.join(', ')}`)
	}
	const malformed = expected.filter((name) => !(keys[name] ?? '').startsWith(API_KEY_PREFIX))
	if (malformed.length > 0) throw new Error(`composeLocalApplication: ${malformed.join(', ')} is not a ${API_KEY_PREFIX} key`)
	return keys
}

/**
 * The proxy Worker of a local run with its manifest as the `FABRIKA_PROXY_MANIFEST_JSON` variable instead of a baked
 * `define`, which Lopata does not apply; an unbaked proxy Worker reads the variable. Locally no 5 KB cap applies.
 */
const withManifestVariable = (proxy: Worker): Worker => {
	const manifest = proxyManifestJson(proxy)
	if (manifest === null) throw new Error('composeLocalApplication: the proxy Worker carries no manifest')
	const { define: _baked, ...options } = proxy.options
	return new Worker({ ...options, vars: { ...options.vars, [FABRIKA_PROXY_MANIFEST_JSON]: manifest } })
}

/**
 * The proxy Worker and the application Worker of a local run (`oblaka.ts`, lopata), composed by the code a deploy runs:
 * the platform's proxy over the contract's endpoint table, and the application's object, files bucket and repair tick,
 * as a release that serves alarms gets them. No deploy takes it. With no Control to write them, the framework values
 * come from here, and the proxy secret, which a deploy uploads as a Worker secret, is drawn anew on each call and
 * written as a variable into the ignored `wrangler.jsonc`, with the workload keys it is given. The proxy's manifest is a
 * variable, not the deploy's baked `define`.
 */
export const composeLocalApplication = (options: LocalApplicationOptions): Worker => {
	const { config, contract, env } = options
	const domain = options.domain === undefined ? {} : { domain: options.domain }
	const iamAppId = appEnvironmentId(config.id, env)
	const target: ApplicationTarget = {
		appId: config.id,
		env,
		...domain,
		vars: {},
		secrets: {},
		managedEnvironment: parseManagedEnvironment({
			[FABRIKA_IAM_ISSUER]: options.iamOrigin,
			[FABRIKA_IAM_APP_ID]: iamAppId,
			[FABRIKA_PROXY_SECRET]: `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll('-', ''),
			...localWorkloadKeys(contract, options.workloadKeys),
		}),
	}
	// The local run reads the contract with this release, so it is gated as a local deploy is.
	assertCloudflareContract(contract, { capsSegments: true, servesSql: true })
	assertContractSchema(configSchema(config), contract, 'refuse')
	const served: ServedContract = { contract, digest: contractDigest(contract) }
	const proxied = platformProxied(config.resources({ env, ...domain }), served, target, false)
	assertNoFrameworkVariables(config, applicationWorker(proxied), target)
	const managed = withManagedEnvironment(config, proxied, target, contractEnvironment(target.managedEnvironment, served))
	const application = applicationWorker(managed.worker)
	const withSecrets = replaceApplicationWorker(
		managed.worker,
		new Worker({ ...application.options, vars: { ...application.options.vars, ...managed.secrets } }),
	)
	const identified = withIamIdentity(withSecrets, iamAppId, undefined)
	const connected = withConnectorBindings(identified, connectorBindings(contract))
	// As a deploy: a Worker that declares its own `assets` keeps them; otherwise the staged mounts are bound as `ASSETS`.
	const mounts = assetMounts(contract)
	const authoredAssets = applicationWorker(connected).options.assets !== undefined
	if (authoredAssets && options.assets !== undefined) {
		throw new Error('composeLocalApplication: the application Worker declares its own `assets`, so nothing is staged; drop `assets`')
	}
	const spaAssets = mounts.length > 0 && !authoredAssets
	if (spaAssets && (options.assets === undefined || !sameMounts(options.assets.mounts, mounts))) {
		throw new Error(
			'composeLocalApplication: the contract serves SPA files; stage them first with `await stageLocalAssets(contract, <application root>)` and pass its result as `assets`',
		)
	}
	return withManifestVariable(withApplicationRuntime(connected, target, applicationRuntime(target, contract, null, true), false, spaAssets))
}
