// The installation model (ADR-0092) as AWS renders it: the neutral model with Control's AWS entry points, a job's
// schedule as the interval of the loop that runs it beside its service, and the AWS provider's own variables with the
// model's kinds. What stays AWS's own (task sizes, the images' fixed names, the security groups' wording, the stacks'
// order) is in `services.ts`, `runtime.ts` and `apply.ts`.

import {
	checkProviderVariables,
	type InstallationSecrets,
	type ModelVariable,
	type PlatformInstallationModel,
	platformInstallationModel,
	type PlatformService,
	variableKey,
} from '@fabrika/installation-init'

/** The platform installation every AWS release renders, with Control's AWS composition root. */
export const awsInstallationModel: PlatformInstallationModel = platformInstallationModel({
	control: {
		migrate: 'packages/control/src/aws/migrate.ts',
		server: 'packages/control/src/aws/server.ts',
		job: 'packages/control/src/aws/cron.ts',
	},
})

const derived = (name: string): ModelVariable => ({ kind: 'derived', name, sensitive: false })

/**
 * Control's AWS variables beside the model's (ADR-0092), with the model's kinds. Every one but the proxy key is derived
 * from the stacks' outputs, the operator's plan or the release, so every run writes it when it differs. Each bucket's
 * `_REGION`, `_CREDENTIALS` and `_ADDRESSING` are under the model's bucket prefixes (`data`), not here.
 * `__tests__/model.test.ts` holds the names a run writes to this list.
 */
export const AWS_CONTROL_VARIABLES: readonly ModelVariable[] = checkProviderVariables(awsInstallationModel, 'control', [
	// Where the applications run (`access.ts`).
	derived('FABRIKA_AWS_ACCOUNT_ID'),
	derived('FABRIKA_AWS_REGION'),
	derived('FABRIKA_AWS_CLUSTER'),
	derived('FABRIKA_AWS_SOURCES_BUCKET'),
	// The applications' network (`network.ts`).
	derived('FABRIKA_AWS_VPC_ID'),
	derived('FABRIKA_AWS_SUBNETS'),
	derived('FABRIKA_AWS_TASK_PUBLIC_IP'),
	derived('FABRIKA_AWS_VPC_CIDR'),
	derived('FABRIKA_AWS_BALANCER_SUBNET_CIDRS'),
	// The applications' balancer (`balancers.ts`).
	derived('FABRIKA_AWS_BALANCER_SECURITY_GROUP'),
	derived('FABRIKA_AWS_BALANCER_LISTENER'),
	derived('FABRIKA_AWS_INSTALLATION_HOSTS'),
	// The image an application's build starts from, and the namespace proxies' source and IAM.
	derived('FABRIKA_AWS_BASE_IMAGE'),
	derived('FABRIKA_AWS_PROXY_REPOSITORY'),
	derived('FABRIKA_AWS_PROXY_COMMIT_SHA'),
	derived('FABRIKA_AWS_PROXY_IAM_URL'),
	// IAM's proxy key, which Control hands to the namespace proxies.
	{ kind: 'generated', name: 'FABRIKA_AWS_PROXY_IAM_KEY', secret: 'proxyKey' },
])

/** Each task's AWS variables beside the model's: Control's alone. */
export const AWS_PROVIDER_VARIABLES: Readonly<Record<PlatformService, readonly ModelVariable[]>> = {
	iam: [],
	operations: [],
	control: AWS_CONTROL_VARIABLES,
	proxy: [],
}

/** The kind of one of a task's AWS variables, or `undefined` for a name it does not declare. */
export function awsProviderVariableKind(service: PlatformService, name: string): ModelVariable['kind'] | undefined {
	return AWS_PROVIDER_VARIABLES[service].find((variable) => variableKey(variable) === name)?.kind
}

/** Each task's generated variables, by name, with the secret each carries: the model's and the AWS provider's own. */
export const AWS_GENERATED: Readonly<Record<PlatformService, ReadonlyMap<string, keyof InstallationSecrets>>> = {
	iam: generatedOf('iam'),
	operations: generatedOf('operations'),
	control: generatedOf('control'),
	proxy: generatedOf('proxy'),
}

function generatedOf(service: PlatformService): ReadonlyMap<string, keyof InstallationSecrets> {
	const generated = new Map<string, keyof InstallationSecrets>()
	for (const variable of [...awsInstallationModel.services[service].environment, ...AWS_PROVIDER_VARIABLES[service]]) {
		if (variable.kind !== 'generated') continue
		// A credential the provider makes for itself; the AWS provider makes none.
		if (variable.secret === undefined) throw new Error(`aws: the ${service} task's generated ${variable.name} has no value of its own here`)
		generated.set(variable.name, variable.secret)
	}
	return generated
}

/**
 * The generated secrets an upgrade may make when no reader holds one (a key a release added after the installation was
 * made, as Zerops' deploy makes IAM's data key). Every other one is the install's alone, and its absence a loss.
 */
export const AWS_UPGRADE_MAY_ADD: ReadonlySet<keyof InstallationSecrets> = new Set(
	Object.entries(awsInstallationModel.secrets).flatMap(([secret, { upgrade }]) => (upgrade === 'mint' && isSecret(secret) ? [secret] : [])),
)

function isSecret(name: string): name is keyof InstallationSecrets {
	return Object.hasOwn(awsInstallationModel.secrets, name)
}

/**
 * Whether a name of the installation's environment is a store's coordinate (`data`): a database's DSN, or a name under
 * a bucket's prefix. Every run writes them when they differ, because a DSN carries the password the run reads.
 *
 * A bucket's key pair would count too, and so be rewritten on every run rather than written once; on AWS it is never
 * written at all (the task role signs, so its value is empty and `desiredAwsParameters` skips it).
 */
export function isAwsDataVariable(service: PlatformService, name: string): boolean {
	return awsInstallationModel.services[service].environment.some((variable) =>
		variable.kind === 'data' && ('prefix' in variable ? name.startsWith(`${variable.prefix}_`) : variableKey(variable) === name)
	)
}

const DAILY = /^([0-5]?\d) ([01]?\d|2[0-3]) \* \* \*$/
const EVERY_N_MINUTES = /^\*\/([1-9]\d*) \* \* \* \*$/

/**
 * A job's schedule as the interval, in seconds, of the loop that runs it beside its service. A loop keeps an interval,
 * not a time of day (ADR-0092): every minute, every N minutes, and `M H * * *` as every 24 hours from the task's start.
 *
 * Every N minutes only where N divides 60: cron restarts the count each hour, so a step of 90 runs at minute 0 of every
 * hour and a step of 45 at minutes 0 and 45, which no fixed interval matches. A loop must not disagree with how a crontab
 * (Zerops') runs the same schedule.
 */
export function awsJobInterval(schedule: string): number {
	if (schedule === '* * * * *') return 60
	const minutes = Number(EVERY_N_MINUTES.exec(schedule)?.[1] ?? Number.NaN)
	if (Number.isInteger(minutes) && 60 % minutes === 0) return minutes * 60
	if (DAILY.test(schedule)) return 86_400
	throw new Error(`aws: a job's schedule ${schedule} is none a loop runs: every minute, every N minutes for an N that divides 60, or once a day`)
}
