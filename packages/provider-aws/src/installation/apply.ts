// The platform's stacks in the order each needs the one before (the AWS idea's checklist, step 11, the commands'
// step): what `platform install` and `platform upgrade` both run, with the operator's own credentials. Every step is
// idempotent, so an install that stopped part way (a stack still settling, a refused call) is resumed by running it
// again, and an upgrade is the same run over a newer release.
//
// 1. The two networks, then the balancers over them (the platform's certificates already issued).
// 2. The database's passwords, each written once: the master's is what the instance was created with, which the setup
//    logs in with, so a later run never replaces it; a service's the setup sets, but nothing needs it to change.
// 3. The database, the services' foundation (`runtime.ts`) and access (`access.ts`, Control's role and boundary).
// 4. The images: their repositories and build project, then the release's two images, by digest (`images`).
// 5. The database setup's stack, then its task, run in the platform's network and awaited: it exits 0 or the run stops.
//    A setup an earlier run started and left running is awaited first, so two never race on one role. On an upgrade
//    the setup runs before any service moves to the new release, so its users and databases exist before the new
//    release's migrations. What has moved by then: the stacks before it (access among them, so Control's role and
//    boundary are the new release's while the old Control still runs) and the images, which nothing runs yet.
// 6. Each task's parameters (`parameters`), then the services' stack. The parameters are written before the services
//    update, so a services update CloudFormation rolls back restarts the old release's tasks with the new values.
// 7. The services' Service Connect names. A task resolves only the endpoints that existed when its service deployed,
//    and the three services dial each other, so on a fresh install the ones created before the last cannot reach it.
//    Every platform service whose current deployment started before the three all existed (and a minute's margin) is
//    redeployed once and awaited. An upgrade's services were created long before, so it redeploys none.
//
// What the images are built from and what each task's parameters hold are this module's callers' (the release's
// commit, `installation-init`'s environment): the order is this module's alone. A read refused for rate or with a
// lost answer is read again at the next poll; a refused write stops the run, which a later run resumes.
//
// UNVERIFIED: that a database's stack settles within the hour this waits, that `RunTask` from the operator's
// credentials places the setup in the platform's cluster as named, and that a task resolves only the endpoints its
// service's deployment saw (ECS's Service Connect guide says so); none was checked against an account.

import type { CloudFormationClient } from '../aws/cloudformation'
import { type EcsPlatformService, type EcsPlatformTasks, type EcsTaskRun, TASK_DEFINITION_ARN } from '../aws/ecs'
import type { SsmPlatformSecrets } from '../aws/ssm'
import { type AwsStack, ensureStack, readAgainLater, UNREAD } from '../stack'
import { AWS_PLATFORM_CLUSTER, awsAccessStack } from './access'
import {
	AWS_PLATFORM_SERVICES,
	type AwsBalancersInput,
	type AwsBalancersOutputs,
	awsBalancersOutputs,
	awsBalancersStack,
	type AwsPlatformRecord,
} from './balancers'
import {
	AWS_DATABASE_ADMIN_PASSWORD_PARAMETER,
	AWS_DATABASE_SERVICES,
	type AwsDatabaseOutputs,
	awsDatabaseOutputs,
	awsDatabasePasswordParameter,
	awsDatabaseStack,
} from './database'
import { awsImagesStack } from './images'
import { type AwsNetworkLayout, awsNetworkLayout, type AwsNetworkOutputs, awsNetworkOutputs, awsNetworkStack, checkAwsNetworksApart } from './network'
import { AWS_PLATFORM_SERVICE_TASKS, type AwsRuntimeOutputs, awsRuntimeOutputs, awsRuntimeStack } from './runtime'
import { awsDatabaseSetupRun, awsPlatformServiceName, type AwsServicesInput, awsServicesStack, awsSetupStack } from './services'

/** How long a stack that creates or modifies the database instance is waited for. */
export const AWS_DATABASE_STACK_TIMEOUT_MS = 60 * 60 * 1000
/** How often the setup's task is read, and how long it is waited for. */
export const AWS_SETUP_POLL_MS = 10_000
export const AWS_SETUP_TIMEOUT_MS = 20 * 60 * 1000
/** Who the setup's task is started by: what an earlier run's setup still running is found by (`ListTasks`). */
export const AWS_SETUP_STARTED_BY = 'fabrika-platform-setup'
/** The setup's container, whose exit code decides the run. */
const SETUP_CONTAINER = 'setup'
/** How often a redeployed service is read, and how long its rollout is waited for. */
export const AWS_ROLLOUT_POLL_MS = 15_000
export const AWS_ROLLOUT_TIMEOUT_MS = 30 * 60 * 1000
/** How long after the last service's creation a deployment still counts as one that may not have seen it. */
const ENDPOINT_MARGIN_MS = 60_000
/** A generated password's length and alphabet: letters and digits alone (`database.ts`). */
const PASSWORD_LENGTH = 40
const PASSWORD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** What the operator chose: where the installation is, its two address ranges, and its hosts and certificates. */
export interface AwsPlatformPlan {
	readonly accountId: string
	readonly region: string
	/** Each network's /16 (`network.ts`), apart. */
	readonly vpcCidrs: { readonly apps: string; readonly platform: string }
	readonly hosts: AwsPlatformRecord<string>
	readonly certificates: AwsPlatformRecord<string>
	readonly appsDefault: AwsBalancersInput['appsDefault']
}

/** What the platform's stacks answered, as far as the run got: what the images and the parameters are made from. */
export interface AwsPlatformState {
	readonly plan: AwsPlatformPlan
	readonly apps: AwsNetworkOutputs
	readonly platform: AwsNetworkOutputs
	readonly balancers: AwsBalancersOutputs
	readonly database: AwsDatabaseOutputs
	readonly runtime: AwsRuntimeOutputs
}

/** The digests the release's two images were pushed under. */
export type AwsPlatformImages = AwsServicesInput['images']

export interface AwsPlatformApplyInput {
	readonly plan: AwsPlatformPlan
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	readonly tasks: EcsPlatformTasks
	readonly secrets: Pick<SsmPlatformSecrets, 'putSecretOnce'>
	/** Builds the release's two images, or finds them built, and answers their digests (`images.ts`). */
	readonly images: (state: AwsPlatformState) => Promise<AwsPlatformImages>
	/** Writes each task's parameters and answers the names it wrote (`services.ts`'s `variables`). */
	readonly parameters: (state: AwsPlatformState) => Promise<AwsServicesInput['variables']>
	readonly signal: AbortSignal
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly log: (line: string) => void
	readonly now?: () => number
	/** An idempotency token, one per call sent. */
	readonly newToken?: () => string
	/** A database password, `PASSWORD_LENGTH` letters and digits. */
	readonly newPassword?: () => string
}

/** What the run leaves behind for the operator: where to point the hosts. */
export interface AwsPlatformApplied extends AwsPlatformState {
	readonly images: AwsPlatformImages
}

/** A password of letters and digits from the platform's random source, without the bias of a modulo. */
export function awsDatabasePassword(): string {
	const limit = 256 - (256 % PASSWORD_ALPHABET.length)
	let password = ''
	while (password.length < PASSWORD_LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(PASSWORD_LENGTH * 2))) {
			if (byte < limit && password.length < PASSWORD_LENGTH) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length] ?? ''
		}
	}
	return password
}

/** Applies every stack of the platform in order and runs the database setup between the images and the services. */
export async function applyAwsPlatform(input: AwsPlatformApplyInput): Promise<AwsPlatformApplied> {
	const { plan, signal, log } = input
	const newToken = input.newToken ?? (() => crypto.randomUUID())
	const newPassword = input.newPassword ?? awsDatabasePassword
	const layouts: { readonly apps: AwsNetworkLayout; readonly platform: AwsNetworkLayout } = {
		apps: awsNetworkLayout(plan.vpcCidrs.apps),
		platform: awsNetworkLayout(plan.vpcCidrs.platform),
	}
	checkAwsNetworksApart(layouts.apps, layouts.platform)
	const apply = (stack: AwsStack, timeoutMs?: number) =>
		ensureStack({
			cloudFormation: input.cloudFormation,
			stack,
			signal,
			sleep: input.sleep,
			log,
			newToken,
			...(input.now === undefined ? {} : { now: input.now }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
		})

	const apps = awsNetworkOutputs(await apply(awsNetworkStack(layouts.apps, 'apps')))
	const platform = awsNetworkOutputs(await apply(awsNetworkStack(layouts.platform, 'platform')))
	const balancers = awsBalancersOutputs(
		await apply(awsBalancersStack({ apps, platform, hosts: plan.hosts, certificates: plan.certificates, appsDefault: plan.appsDefault })),
	)

	for (const name of [AWS_DATABASE_ADMIN_PASSWORD_PARAMETER, ...AWS_DATABASE_SERVICES.map(awsDatabasePasswordParameter)]) {
		if (await input.secrets.putSecretOnce(name, newPassword(), signal)) log(`aws: wrote the database password ${name}`)
	}
	const database = awsDatabaseOutputs(await apply(awsDatabaseStack(platform), AWS_DATABASE_STACK_TIMEOUT_MS))
	const runtime = awsRuntimeOutputs(
		await apply(
			awsRuntimeStack({
				accountId: plan.accountId,
				region: plan.region,
				platform,
				balancers: { platformBalancerGroupId: balancers.platformBalancerGroupId },
			}),
		),
	)
	await apply(awsAccessStack({
		accountId: plan.accountId,
		region: plan.region,
		appsListenerArn: balancers.appsListenerArn,
		vpcId: apps.vpcId,
		taskSubnetIds: apps.taskSubnetIds,
		installationHosts: [...AWS_PLATFORM_SERVICES.map((service) => plan.hosts[service]), plan.appsDefault.host],
		platformNamespaceArn: runtime.namespaceArn,
	}))
	await apply(awsImagesStack({ accountId: plan.accountId, region: plan.region }))
	const state: AwsPlatformState = { plan, apps, platform, balancers, database, runtime }
	const images = await input.images(state)

	const setup = await apply(awsSetupStack({ accountId: plan.accountId, region: plan.region, database, images: { services: images.services } }))
	const definition = setup['SetupTaskDefinitionArn'] ?? ''
	if (!TASK_DEFINITION_ARN.test(definition)) throw new Error("aws: the setup's stack's SetupTaskDefinitionArn output is of another form")
	await runDatabaseSetup(input, definition, awsDatabaseSetupRun({ platform, runtime, database }).network, newToken())

	const variables = await input.parameters(state)
	await apply(awsServicesStack({ accountId: plan.accountId, region: plan.region, platform, runtime, database, balancers, images, variables }))
	await connectServices(input)
	log(
		`aws: the platform serves; point ${AWS_PLATFORM_SERVICES.map((service) => plan.hosts[service]).join(', ')} at ${balancers.platformBalancerDnsName}`,
	)
	return { ...state, images }
}

/** Runs the setup's task and waits for it to stop: exit code 0, or an error naming ECS's stop code and reason. */
async function runDatabaseSetup(
	input: AwsPlatformApplyInput,
	taskDefinitionArn: string,
	network: ReturnType<typeof awsDatabaseSetupRun>['network'],
	clientToken: string,
): Promise<void> {
	const { tasks, signal, log } = input
	// An earlier run's setup still running is awaited, whatever it ends with: this run's own decides.
	for (const arn of await tasks.listRunningTasks(AWS_PLATFORM_CLUSTER, AWS_SETUP_STARTED_BY, signal)) {
		log(`aws: waiting for the database setup ${arn} an earlier run started`)
		await untilStopped(input, { arn, status: 'running', exitCode: null, stopCode: null, reason: null })
	}
	const started = await tasks.runTask(
		{ cluster: AWS_PLATFORM_CLUSTER, taskDefinitionArn, container: SETUP_CONTAINER, network, clientToken, startedBy: AWS_SETUP_STARTED_BY },
		signal,
	)
	log(`aws: running the database setup (${started.arn})`)
	const run = await untilStopped(input, started)
	if (run.exitCode !== 0) {
		const why = [run.exitCode === null ? 'no exit code' : `exit code ${run.exitCode}`, run.stopCode, run.reason].filter((part) => part !== null)
		throw new Error(`aws: the database setup ${run.arn} failed (${why.join('; ')}); its log group names the step`)
	}
	log('aws: the database setup is done')
}

/** The setup's task `run` once it stopped, read every `AWS_SETUP_POLL_MS`; a read refused for rate is read again. */
async function untilStopped(input: AwsPlatformApplyInput, run: EcsTaskRun): Promise<EcsTaskRun> {
	const { tasks, signal } = input
	const now = input.now ?? Date.now
	const giveUpAt = now() + AWS_SETUP_TIMEOUT_MS
	let current = run
	while (current.status !== 'stopped') {
		if (now() >= giveUpAt) {
			throw new Error(`aws: the database setup ${run.arn} did not stop within ${AWS_SETUP_TIMEOUT_MS / 60_000} minutes; its log group says where it is`)
		}
		await input.sleep(AWS_SETUP_POLL_MS, signal)
		const read = await readAgainLater(() => tasks.describeTask(AWS_PLATFORM_CLUSTER, run.arn, SETUP_CONTAINER, signal))
		if (read === null) throw new Error(`aws: the database setup ${run.arn} is gone before it stopped`)
		if (read !== UNREAD) current = read
	}
	return current
}

/**
 * Redeploys, once, each platform service whose current deployment may predate an endpoint it dials (step 7 above),
 * and waits until each rollout completes.
 */
async function connectServices(input: AwsPlatformApplyInput): Promise<void> {
	const { tasks, signal, log } = input
	const now = input.now ?? Date.now
	const read = async (name: string): Promise<EcsPlatformService> => {
		const service = await tasks.describeService(AWS_PLATFORM_CLUSTER, name, signal)
		if (service === null) throw new Error(`aws: the platform service ${name} is not active`)
		return service
	}
	const primaryOf = (name: string, service: EcsPlatformService) => {
		const primary = service.deployments.find((deployment) => deployment.status === 'primary')
		if (primary === undefined) throw new Error(`aws: the platform service ${name} has no primary deployment`)
		return primary
	}
	const published = AWS_PLATFORM_SERVICE_TASKS.map(awsPlatformServiceName)
	const names = [...published, awsPlatformServiceName('proxy')]
	const services = new Map<string, EcsPlatformService>()
	for (const name of names) services.set(name, await read(name))
	const lastCreated = Math.max(...published.map((name) => services.get(name)?.createdAt.getTime() ?? 0))
	const stale = names.filter((name) => {
		const service = services.get(name)
		return service !== undefined && primaryOf(name, service).createdAt.getTime() < lastCreated + ENDPOINT_MARGIN_MS
	})
	const before = new Map<string, string>()
	for (const name of stale) {
		const service = services.get(name)
		if (service !== undefined) before.set(name, primaryOf(name, service).id)
		await tasks.redeployService(AWS_PLATFORM_CLUSTER, name, signal)
		log(`aws: redeploying ${name}, whose tasks started before every platform service existed`)
	}
	const giveUpAt = now() + AWS_ROLLOUT_TIMEOUT_MS
	const waiting = new Set(stale)
	while (waiting.size > 0) {
		if (now() >= giveUpAt) throw new Error(`aws: ${[...waiting].join(', ')} did not roll out within ${AWS_ROLLOUT_TIMEOUT_MS / 60_000} minutes`)
		await input.sleep(AWS_ROLLOUT_POLL_MS, signal)
		for (const name of [...waiting]) {
			const service = await readAgainLater(() => read(name))
			if (service === UNREAD) continue
			const primary = primaryOf(name, service)
			// The redeploy's own deployment, once ECS made it the primary one.
			if (primary.id === before.get(name)) continue
			if (primary.rolloutState === 'failed') throw new Error(`aws: redeploying ${name} failed; its events say why`)
			if (primary.rolloutState === 'completed') {
				waiting.delete(name)
				log(`aws: ${name} is redeployed`)
			}
		}
	}
}
