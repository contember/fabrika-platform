// Each platform task's parameters (the AWS idea's checklist, step 11, the commands' step): what `applyAwsPlatform`'s
// `parameters` writes before the services' stack, under each task's own path (`/fabrika/platform/<task>/<NAME>`), which
// the task definition names as secrets. The names and values are `installation-init`'s, the same as on every cloud
// (`installationServiceEnvironment`, `deployedServiceEnvironment`), and the AWS provider adds its own beside them.
//
// Three kinds of value, each written its own way:
//
// - **Generated** (`INSTALLATION_SECRET_VARIABLES`: the signing keys, the RPC, proxy, provisioning and sync keys, the
//   vault and data keys, and Control's copy of the proxy key for the namespace proxies): written once and never
//   replaced. A secret several services read is one value in each reader's path, so a run that stopped part way takes
//   the value an earlier run wrote from any reader that holds it, and refuses to go on when two readers hold different
//   ones. Losing the vault key loses every application's secrets, so nothing here ever writes over one: a generated
//   name is refused on the path that replaces values, and an upgrade refuses a key no reader holds rather than make a
//   new one that would hide the loss (IAM's data key alone may be added, as Zerops' deploy adds it). A write that finds
//   the parameter already there (a run at the same time) is read back and must hold the settled value.
// - **Bring-up only** (how people sign in, the outbound mail): written once, on install, so a sign-in method or a
//   mailer an operator changed by hand survives every upgrade, as on Zerops. An upgrade names none.
// - **Derived** (where the installation answers, each service's database URL from its password, the buckets, Control's
//   AWS coordinates, the console's table digest and OAuth configuration): written on every run whose value differs, so
//   an upgrade converges them.
//
// The storage of Control's run logs and Operations' blobs is the account's own S3: each task signs with its task role
// (`_CREDENTIALS=container`), so no key is written. The proxy reaches IAM at `iam:3000` in the platform's Service
// Connect namespace.
//
// The answer is the names now under each task's path, which the services' stack names as secrets: a name an earlier
// run or an operator wrote stays readable. No value reaches a log or an error.

import {
	deployedServiceEnvironment,
	type DeployedServiceInput,
	generateInstallationSecrets,
	INSTALLATION_SECRET_VARIABLES,
	type InstallationAuthentication,
	type InstallationEmail,
	type InstallationSecrets,
	installationServiceEnvironment,
	platformOrigin,
	type PlatformService,
} from '@fabrika/installation-init'
import type { SsmPlatformSecrets } from '../aws/ssm'
import { awsAccessEnvironment, awsRunLogsBucket } from './access'
import { awsPlatformAccessInput, type AwsPlatformState } from './apply'
import { awsBalancersEnvironment } from './balancers'
import { AWS_DATABASE_SERVICES, awsDatabasePasswordParameter, awsDatabaseUrl } from './database'
import { awsNetworkEnvironment, awsNetworkLayout } from './network'
import { AWS_PLATFORM_SERVICE_PORT, awsOperationsBucket, awsPlatformParameters } from './runtime'
import type { AwsServicesInput } from './services'

/** The installation's scheme: every platform host has an ACM certificate on the platform balancer. */
const SCHEME = 'https'
/** Where the platform proxy dials IAM, which owns the session: IAM's Service Connect name. */
const IAM_UPSTREAM = `iam:${AWS_PLATFORM_SERVICE_PORT}`
/** The four tasks whose parameters this writes. */
const TASKS: readonly PlatformService[] = ['iam', 'control', 'operations', 'proxy']

/** Each generated variable's value in `InstallationSecrets`. A name missing here is refused, never left unwritten. */
const GENERATED: Readonly<Record<string, keyof InstallationSecrets>> = {
	FABRIKA_IAM_SIGNING_KEYS: 'signingKeys',
	FABRIKA_IAM_RPC_KEY: 'rpcKey',
	FABRIKA_IAM_PROXY_KEY: 'proxyKey',
	FABRIKA_IAM_KEY: 'proxyKey',
	FABRIKA_AWS_PROXY_IAM_KEY: 'proxyKey',
	FABRIKA_IAM_PROVISIONING_KEY: 'provisioningKey',
	FABRIKA_IAM_DATA_KEY: 'dataKey',
	OPERATIONS_SYNC_KEY: 'operationsSyncKey',
	FABRIKA_CONTROL_VAULT_KEY: 'vaultKey',
}
/** The generated variables each task reads: `installation-init`'s, and Control's copy of the proxy key. */
const GENERATED_READERS: Readonly<Record<PlatformService, readonly string[]>> = {
	...INSTALLATION_SECRET_VARIABLES,
	control: [...INSTALLATION_SECRET_VARIABLES.control, 'FABRIKA_AWS_PROXY_IAM_KEY'],
}

/**
 * The generated keys an upgrade may make when no reader holds one, as Zerops' deploy makes IAM's data key: a key a
 * release added after the installation was made. Every other key is the install's alone, and its absence a loss.
 */
const UPGRADE_MAY_ADD: ReadonlySet<keyof InstallationSecrets> = new Set(['dataKey'])

/** What the run settles before it writes: where the stacks are, and the release the installation runs. */
export interface AwsParametersInput {
	readonly state: AwsPlatformState
	/** The installation's environment name (`ENVIRONMENT`). */
	readonly environment: string
	/** How people sign in and the outbound mail: given on install alone, written once. */
	readonly bringUp?: { readonly authentication: InstallationAuthentication; readonly email: InstallationEmail }
	/** What the platform proxy's manifest settles (`installation-init`'s `platformServiceTableDigest` and OAuth). */
	readonly manifest: Pick<DeployedServiceInput, 'controlTableDigest' | 'oauthConfig' | 'operationsOAuthResource'>
	/** The release's repository (`owner/name`) and commit, which the namespace proxies are built from. */
	readonly release: { readonly repository: string; readonly commitSha: string }
	/** The Bun image an application's build starts from, by digest (`FABRIKA_AWS_BASE_IMAGE`). */
	readonly baseImage: string
	readonly secrets: SsmPlatformSecrets
	readonly signal: AbortSignal
	readonly log: (line: string) => void
	/** The secrets a fresh installation is given; `installation-init`'s by default. */
	readonly newSecrets?: () => InstallationSecrets
}

const parameterOf = (task: PlatformService, name: string) => `${awsPlatformParameters(task)}${name}`

/** The generated secrets: each the value its readers already hold, or a new one; refused when two readers differ. */
async function settledSecrets(input: AwsParametersInput): Promise<InstallationSecrets> {
	const fresh = (input.newSecrets ?? generateInstallationSecrets)()
	const readers = new Map<keyof InstallationSecrets, string[]>()
	for (const task of TASKS) {
		for (const name of GENERATED_READERS[task]) {
			const field = GENERATED[name]
			if (field === undefined) throw new Error(`aws: the ${task} task's generated ${name} has no value of its own here`)
			readers.set(field, [...(readers.get(field) ?? []), parameterOf(task, name)])
		}
	}
	const settled = new Map<keyof InstallationSecrets, string>()
	for (const [field, parameters] of readers) {
		const held = new Set<string>()
		for (const parameter of parameters) {
			const value = await input.secrets.readSecret(parameter, input.signal)
			if (value !== null) held.add(value)
		}
		if (held.size > 1) {
			throw new Error(`aws: the platform's ${field} differs between ${parameters.join(', ')}; an operator must make them one before a run writes more`)
		}
		// An upgrade makes no key the install made: one no reader holds was lost, and a new one would hide that.
		if (held.size === 0 && input.bringUp === undefined && !UPGRADE_MAY_ADD.has(field)) {
			throw new Error(
				`aws: the platform's ${field} is in none of ${parameters.join(', ')}; an upgrade never makes a new one, so restore it from where it was kept`,
			)
		}
		settled.set(field, [...held][0] ?? fresh[field])
	}
	const value = (field: keyof InstallationSecrets): string => settled.get(field) ?? fresh[field]
	return {
		signingKeys: value('signingKeys'),
		rpcKey: value('rpcKey'),
		proxyKey: value('proxyKey'),
		provisioningKey: value('provisioningKey'),
		operationsSyncKey: value('operationsSyncKey'),
		vaultKey: value('vaultKey'),
		dataKey: value('dataKey'),
	}
}

/** Each task's parameters, by kind, before anything is written. */
interface DesiredParameters {
	readonly once: ReadonlyMap<PlatformService, ReadonlyMap<string, string>>
	readonly derived: ReadonlyMap<PlatformService, ReadonlyMap<string, string>>
}

/** What each task's parameters should hold, and which are written once. Reads the database's passwords. */
export async function desiredAwsParameters(input: AwsParametersInput): Promise<DesiredParameters> {
	const { state, signal } = input
	const { plan } = state
	const secrets = await settledSecrets(input)
	const databaseUrl = async (service: (typeof AWS_DATABASE_SERVICES)[number]) => {
		const password = await input.secrets.readSecret(awsDatabasePasswordParameter(service), signal)
		if (password === null) throw new Error(`aws: the database password ${awsDatabasePasswordParameter(service)} is missing`)
		return awsDatabaseUrl(state.database, service, password)
	}
	const storage = (bucket: string) => ({ bucket, accessKeyId: '', secretAccessKey: '', endpoint: '' })
	const placement = { environment: input.environment, scheme: SCHEME, hosts: plan.hosts, iamUpstream: IAM_UPSTREAM } satisfies Pick<
		DeployedServiceInput,
		'environment' | 'scheme' | 'hosts' | 'iamUpstream'
	>
	const installation = installationServiceEnvironment({
		...placement,
		secrets,
		data: {
			iamDatabase: await databaseUrl('iam'),
			controlDatabase: await databaseUrl('control'),
			operationsDatabase: await databaseUrl('operations'),
			runLogs: storage(awsRunLogsBucket(plan.accountId)),
			operationsBlobs: storage(awsOperationsBucket(plan.accountId)),
		},
		email: input.bringUp?.email ?? { kind: 'none' },
		authentication: input.bringUp?.authentication ?? { passwordEnabled: true },
	})
	const deployed = deployedServiceEnvironment({ ...placement, ...input.manifest, provisioningKey: secrets.provisioningKey })
	// The account's own S3, signed with the task role: the key pair and the endpoint stay unwritten.
	const s3 = (prefix: string): ReadonlyMap<string, string> =>
		new Map([[`${prefix}_REGION`, plan.region], [`${prefix}_CREDENTIALS`, 'container'], [`${prefix}_ADDRESSING`, 'virtual']])
	const aws: Readonly<Record<PlatformService, ReadonlyMap<string, string>>> = {
		iam: new Map(),
		operations: s3('FABRIKA_OPERATIONS_BLOB'),
		control: new Map([
			...s3('FABRIKA_CONTROL_RUN_LOGS'),
			...Object.entries(awsAccessEnvironment(awsPlatformAccessInput(state))),
			...Object.entries(awsNetworkEnvironment(awsNetworkLayout(plan.vpcCidrs.apps), state.apps)),
			...Object.entries(awsBalancersEnvironment(state.balancers, plan)),
			['FABRIKA_AWS_BASE_IMAGE', input.baseImage],
			['FABRIKA_AWS_PROXY_REPOSITORY', `https://github.com/${input.release.repository}`],
			['FABRIKA_AWS_PROXY_COMMIT_SHA', input.release.commitSha],
			['FABRIKA_AWS_PROXY_IAM_URL', platformOrigin(SCHEME, plan.hosts.iam)],
			['FABRIKA_AWS_PROXY_IAM_KEY', secrets.proxyKey],
		]),
		proxy: new Map(),
	}
	// What a deploy derives, or the AWS provider does: rewritten whenever it differs. Everything else of the
	// installation's environment is the bring-up's own, written once.
	const derivedNames = new Set([
		'FABRIKA_IAM_DATABASE_URL',
		'FABRIKA_CONTROL_DATABASE_URL',
		'FABRIKA_OPERATIONS_DATABASE_URL',
		'FABRIKA_CONTROL_RUN_LOGS_BUCKET',
		'FABRIKA_OPERATIONS_BLOB_BUCKET',
	])
	const once = new Map<PlatformService, Map<string, string>>()
	const derived = new Map<PlatformService, Map<string, string>>()
	for (const task of TASKS) {
		const taskOnce = new Map<string, string>()
		const taskDerived = new Map<string, string>()
		const generated = new Set(GENERATED_READERS[task])
		for (const [name, value] of [...installation[task], ...aws[task]]) {
			// A storage key, a secret key or an endpoint the account's own S3 takes none of.
			if (value === '') continue
			if (generated.has(name)) taskOnce.set(name, value)
			else if (derivedNames.has(name) || deployed[task].has(name) || aws[task].has(name)) taskDerived.set(name, value)
			else if (input.bringUp !== undefined) taskOnce.set(name, value)
		}
		for (const [name, value] of deployed[task]) taskDerived.set(name, value)
		// A generated key is never on the path that replaces values, whatever a later `installation-init` derives.
		const replaced = [...taskDerived.keys()].find((name) => generated.has(name))
		if (replaced !== undefined) throw new Error(`aws: the ${task} task's generated ${replaced} would be replaced by a derived value`)
		once.set(task, taskOnce)
		derived.set(task, taskDerived)
	}
	return { once, derived }
}

/**
 * Writes each task's parameters (generated and bring-up values once, derived ones when they differ) and answers the
 * names under each task's path, which the services' stack names.
 */
export async function writeAwsParameters(input: AwsParametersInput): Promise<AwsServicesInput['variables']> {
	const { secrets, signal, log } = input
	const desired = await desiredAwsParameters(input)
	for (const task of TASKS) {
		const written: string[] = []
		for (const [name, value] of desired.once.get(task) ?? []) {
			const parameter = parameterOf(task, name)
			if (await secrets.putSecretOnce(parameter, value, signal)) {
				written.push(name)
			} else if (GENERATED_READERS[task].includes(name) && (await secrets.readSecret(parameter, signal)) !== value) {
				// Settled from its readers, yet another value is there: a run at the same time won this reader's path.
				throw new Error(`aws: ${parameter} holds another value than its readers settled on; run again once no other run writes`)
			}
		}
		for (const [name, value] of desired.derived.get(task) ?? []) {
			const parameter = parameterOf(task, name)
			if ((await secrets.readSecret(parameter, signal)) === value) continue
			await secrets.putSecret(parameter, value, signal)
			written.push(name)
		}
		log(written.length === 0 ? `aws: the ${task} task's parameters are current` : `aws: wrote the ${task} task's ${written.join(', ')}`)
	}
	const names = async (task: PlatformService): Promise<readonly string[]> => {
		const path = awsPlatformParameters(task)
		const listed = await secrets.listNames(path.slice(0, -1), signal)
		return listed.map((name) => name.slice(path.length))
	}
	return { iam: await names('iam'), control: await names('control'), operations: await names('operations'), proxy: await names('proxy') }
}
