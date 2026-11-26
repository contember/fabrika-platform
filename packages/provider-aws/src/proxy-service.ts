// A namespace proxy's ECS service (the AWS idea's checklist, step 10): the image `followAwsProxyBuild` recorded, run on
// X86_64 in the installation's network behind the proxy's security group, a Service Connect client of its namespace, so
// it dials each application at the dial address its manifest names (`<discovery name>:3000`).
//
// - Secrets: the IAM key (`FABRIKA_IAM_KEY`) and each routed member's proxy secret (`proxySecretVariable(<app>@<env>)`,
//   ADR-0022 rule 5) go to SecureStrings under the namespace's `env/`, which only the proxy's execution role reads, and
//   reach the container by ARN. The IAM issuer is a plain value. Nothing of either is logged or recorded.
// - The task definition (`awsProxyTaskDefinition`, pure): the proxy container on :8080, a health check on its own
//   listener (:8081) through the image's busybox, the namespace's task and execution roles, never one role (ADR-0004).
// - The service: recorded before the call that sets it (ADR-0044). The revision is registered once per fingerprint (the
//   image, the IAM issuer, the secrets' names and values: `awsProxyServiceFingerprint`) and recorded with it, so a retry
//   reuses it and a new key or secret with the same image is a new revision, whose tasks read the new values;
//   `CreateService` when there is no service (its token derived from the revision, so a lost answer is settled by
//   repeating the same call, and an answer that is not an active service is refused) and `UpdateService` otherwise;
//   `proxyServiceUpdated` once answered. A service of this fingerprint already updated is answered with no call. A
//   draining service is refused, retryably.
// - The service lives outside the namespace's stack and holds its security group, roles and log group, so an
//   operator deletes the service first, then its parameters, then the stack (the namespace's instructions say so).
// - Behind the balancer: the service registers its tasks in the namespace stack's target group at the public port, on
//   every create and update; the proxy's group admits only the balancer's group.
//
// - The rollout (`followAwsProxyRollout`): read through the service's current service deployment, as an application's
//   run reads its own (`run-attempt.ts`), because the service's reads lag an update. Only a successful deployment of the
//   recorded revision deletes the secrets of members no longer routed (a rollback to an older revision reads them).
//
// Not yet: the listener's host rules and certificates, which send each member's host to the target group.
//
// UNVERIFIED: that a Service Connect configuration with a namespace and no services makes the tasks clients of it, and
// that busybox `wget` is in the image's Alpine base, follow ECS's and Alpine's documentation; neither was checked here.

import { appEnvironmentId, proxySecretVariable } from '@fabrika/auth-core'
import {
	type ProviderDeploymentNamespace,
	ProviderNamespaceError,
	type ProviderNamespaceEvents,
	type ProviderNamespaceMember,
} from '@fabrika/provider-contract'
import type { EcsClient, EcsTaskDefinition } from './aws/ecs'
import { parameterArn, type SsmClient } from './aws/ssm'
import type { AwsAppTarget, AwsNamespaceTarget } from './codecs'
import type { AwsInstallationNetwork } from './environment-stack'
import {
	AWS_PROXY_HEALTH_PATH,
	AWS_PROXY_HEALTH_PORT,
	AWS_PROXY_PORT,
	type AwsNamespaceOutputs,
	awsNamespaceResources,
	awsNamespaceTargetEnvelope,
	type AwsProxySource,
	checkNamespaceTarget,
	namespaceFailure,
} from './namespace'
import { sha256Hex } from './proxy-attempt'

export { AWS_PROXY_HEALTH_PATH, AWS_PROXY_HEALTH_PORT, AWS_PROXY_PORT }
/** The proxy's container. */
export const AWS_PROXY_CONTAINER = 'proxy'
/** The smallest Fargate task: the proxy is Caddy and one Bun binary. */
export const AWS_PROXY_CPU = 256
export const AWS_PROXY_MEMORY = 512
/** How many tasks the proxy's service runs. */
export const AWS_PROXY_DESIRED_COUNT = 1
/** The variables the proxy reads (`packages/proxy/src/env.ts`): the IAM issuer, a plain value, and the IAM key, a secret. */
export const AWS_PROXY_IAM_ISSUER = 'FABRIKA_IAM_ISSUER'
export const AWS_PROXY_IAM_KEY = 'FABRIKA_IAM_KEY'

/** The IAM the proxy asks: its issuer's origin, and the key IAM knows as the proxy's. */
export interface AwsProxyIam {
	readonly issuer: string
	/** A credential: never logged, never recorded, written only to Parameter Store. */
	readonly key: string
}

/** The secrets of one proxy, by variable name: the IAM key and each routed member's proxy secret. */
export function awsProxySecrets(members: readonly ProviderNamespaceMember[], iamKey: string): Readonly<Record<string, string>> {
	const secrets: Record<string, string> = { [AWS_PROXY_IAM_KEY]: iamKey }
	for (const member of members) {
		// Only a member the manifest routes (approved access) has an entry whose secret the proxy sends.
		if (member.access === undefined || member.proxySecret === undefined || member.proxySecret === '') continue
		// The manifest's entry id, by the same function, so the variable the proxy reads is the entry's.
		secrets[proxySecretVariable(appEnvironmentId(member.appId, member.env))] = member.proxySecret
	}
	return secrets
}

/**
 * The sha256 of everything the proxy's tasks depend on: the image, the IAM issuer (a plain value of the revision), the
 * secrets' names (the revision's references) and their values (which ECS reads only at a task's start). A change of any
 * of them is a new revision, so the service starts new tasks that read the new values. The values are high-entropy
 * credentials, so their digest names none of them; it is recorded, never they.
 */
export async function awsProxyServiceFingerprint(imageDigest: string, iamIssuer: string, secrets: Readonly<Record<string, string>>): Promise<string> {
	const names = Object.keys(secrets).sort()
	return sha256Hex(JSON.stringify({ imageDigest, iamIssuer, secrets: names.map((name) => [name, secrets[name] ?? '']) }))
}

export interface AwsProxyTaskInput {
	readonly namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>
	readonly installation: Pick<AwsAppTarget, 'accountId' | 'region'>
	/** The recorded image's digest (`sha256:<64 hex>`). */
	readonly imageDigest: string
	readonly iamIssuer: string
	/** The names of the proxy's secrets, each under the namespace's `env/`. */
	readonly secretNames: readonly string[]
}

/** The proxy's task definition, as `ecsClient(…).registerTaskDefinition` takes it. */
export function awsProxyTaskDefinition(input: AwsProxyTaskInput): EcsTaskDefinition {
	const resources = awsNamespaceResources(input.namespace.id, input.namespace.env)
	const { accountId, region } = input.installation
	const role = (name: string): string => `arn:aws:iam::${accountId}:role/fabrika/namespaces/${name}`
	const location = { partition: 'aws', region, accountId }
	const secrets: Record<string, string> = {}
	for (const name of [...input.secretNames].sort()) secrets[name] = parameterArn(location, `${resources.parameterPath}/env/${name}`)
	return {
		family: resources.service,
		taskRoleArn: role(resources.taskRoleName),
		executionRoleArn: role(resources.executionRoleName),
		cpu: AWS_PROXY_CPU,
		memory: AWS_PROXY_MEMORY,
		architecture: 'X86_64',
		containers: [{
			name: AWS_PROXY_CONTAINER,
			image: `${accountId}.dkr.ecr.${region}.amazonaws.com/${resources.repository}@${input.imageDigest}`,
			essential: true,
			port: AWS_PROXY_PORT,
			environment: { [AWS_PROXY_IAM_ISSUER]: input.iamIssuer },
			secrets,
			// Caddy's health route alone, on its own listener: the public one answers only the routes of the manifest.
			healthCheck: {
				command: ['CMD', 'wget', '-q', '-O', '/dev/null', `http://127.0.0.1:${AWS_PROXY_HEALTH_PORT}${AWS_PROXY_HEALTH_PATH}`],
				intervalSeconds: 10,
				timeoutSeconds: 5,
				retries: 3,
				startPeriodSeconds: 30,
			},
			log: { group: resources.logGroup, region, streamPrefix: AWS_PROXY_CONTAINER },
		}],
		tags: { 'fabrika:namespace': input.namespace.id, 'fabrika:env': input.namespace.env },
	}
}

/** The calls that set the proxy's service. */
export interface AwsProxyServiceClients {
	readonly ecs: Pick<EcsClient, 'registerTaskDefinition' | 'createService' | 'updateService' | 'describeService'>
	readonly ssm: Pick<SsmClient, 'putSecret'>
}

export interface AwsProxyServiceInput {
	readonly namespace: ProviderDeploymentNamespace
	/** The namespace's members, read under its lease: their proxy secrets are the proxy's. */
	readonly members: readonly ProviderNamespaceMember[]
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	readonly network: AwsInstallationNetwork
	/** The namespace stack's outputs: the proxy's security group and the Service Connect namespace. */
	readonly outputs: AwsNamespaceOutputs
	readonly iam: AwsProxyIam
	readonly clients: AwsProxyServiceClients
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
}

/**
 * The ECS idempotency token of the service's creation on one revision: at most 36 characters, the same on every retry
 * of that revision's creation and another for any other revision, so a service created again on a newer one is never
 * answered with an earlier creation.
 */
async function createToken(revision: string): Promise<string> {
	return `p-${(await sha256Hex(revision)).slice(0, 32)}`
}

/**
 * Sets the namespace's proxy service to its recorded image: the secrets written, the image's revision registered (once),
 * the service created or updated. Answers the namespace with the service recorded; one already updated to the image is
 * answered as it is.
 */
export async function ensureAwsProxyService(input: AwsProxyServiceInput): Promise<ProviderDeploymentNamespace> {
	try {
		return await ensure(input)
	} catch (error) {
		throw namespaceFailure(error)
	}
}

async function ensure(input: AwsProxyServiceInput): Promise<ProviderDeploymentNamespace> {
	const { clients, installation, signal } = input
	let namespace = input.namespace
	const stored = checkNamespaceTarget(namespace, installation, input.proxySource)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const imageDigest = stored.proxyImageDigest
	if (imageDigest === undefined) throw new Error("aws: the namespace's proxy has no image built to run")
	const secrets = awsProxySecrets(input.members, input.iam.key)
	// Not the image alone: a new IAM key or issuer, or a member's new proxy secret, with the same image is a new revision.
	const fingerprint = await awsProxyServiceFingerprint(imageDigest, input.iam.issuer, secrets)
	if (stored.proxyServiceFingerprint === fingerprint && stored.proxyServiceUpdated === true) return namespace

	const record = async (target: AwsNamespaceTarget): Promise<AwsNamespaceTarget> => {
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(target) }
		await input.events.checkpoint(namespace)
		return target
	}

	// The secrets first: a revision that names one ECS cannot read would never start.
	for (const [name, value] of Object.entries(secrets)) await clients.ssm.putSecret(`${resources.parameterPath}/env/${name}`, value, signal)

	let revision = stored.proxyServiceFingerprint === fingerprint ? stored.proxyServiceTaskDefinitionArn : undefined
	let current = stored
	if (revision === undefined) {
		const definition = awsProxyTaskDefinition({
			namespace,
			installation,
			imageDigest,
			iamIssuer: input.iam.issuer,
			secretNames: Object.keys(secrets),
		})
		revision = (await clients.ecs.registerTaskDefinition(definition, signal)).arn
		const { proxyServiceUpdated: _updated, proxyServiceRolledOut: _rolledOut, ...rest } = stored
		current = await record({ ...rest, proxyServiceTaskDefinitionArn: revision, proxyServiceFingerprint: fingerprint })
	}

	await input.events.boundary()
	const address = { cluster: installation.cluster, service: resources.service }
	const network = { subnets: input.network.subnets, securityGroups: [input.outputs.proxySecurityGroupId], publicIp: input.network.publicIp }
	// The balancer's target group is the namespace stack's own, which keeps it for the stack's life (only a changed VPC
	// replaces it). It is sent with the create and with every update to a new revision, but it is not in the fingerprint,
	// as the proxy's group and the Service Connect namespace are not: a service already updated to this fingerprint is
	// answered with no call, so a replaced group (or target group) reaches it only with the next new revision.
	const serviceConnect = {
		namespaceArn: input.outputs.serviceConnectNamespaceArn,
		balancer: { targetGroupArn: input.outputs.proxyTargetGroupArn, container: AWS_PROXY_CONTAINER, port: AWS_PROXY_PORT },
	}
	const existing = await clients.ecs.describeService(address, signal)
	if (existing?.status === 'draining') {
		throw new ProviderNamespaceError(`aws: the proxy service ${resources.service} is being deleted; try again once it is gone`, 'awsProxyService', true)
	}
	if (existing === null || existing.status === 'inactive') {
		const created = await clients.ecs.createService({
			...address,
			taskDefinitionArn: revision,
			network,
			desiredCount: AWS_PROXY_DESIRED_COUNT,
			clientToken: await createToken(revision),
			tags: { 'fabrika:namespace': namespace.id, 'fabrika:env': namespace.env },
			serviceConnect,
		}, signal)
		// A replayed token may answer a creation ECS has since let go: only an active service is one this call made.
		if (created.status !== 'active') {
			throw new ProviderNamespaceError(`aws: the proxy service ${resources.service} was answered ${created.status}; try again`, 'awsProxyService', true)
		}
	} else {
		await clients.ecs.updateService(address, revision, network, serviceConnect, signal)
	}
	await record({ ...current, proxyServiceUpdated: true })
	return namespace
}

/** The stable code of a proxy rollout ECS's circuit breaker rolled back: not retryable until a new revision is set. */
export const AWS_PROXY_ROLLOUT_FAILED = 'awsProxyRollout'

/** The calls that follow the proxy service's rollout and delete the secrets it no longer names. */
export interface AwsProxyRolloutClients {
	readonly ecs: Pick<EcsClient, 'describeService' | 'describeServiceDeployment' | 'describeServiceRevision'>
	readonly ssm: Pick<SsmClient, 'listNames' | 'deleteSecret'>
}

export interface AwsProxyRolloutInput {
	readonly namespace: ProviderDeploymentNamespace
	/** The members the recorded revision was set for: their secrets are the ones it names. */
	readonly members: readonly ProviderNamespaceMember[]
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	readonly iam: AwsProxyIam
	readonly clients: AwsProxyRolloutClients
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
}

/**
 * Reads the proxy service's current service deployment once (the service, its deployment, the deployment's revision).
 * - Successful, of the recorded revision: the secrets under `env/` that the revision no longer names are deleted (only
 *   now: a rollback would start the older revision, which reads them), and the rollout is recorded, so it is `rolled`.
 * - Stopped or rolled back by the circuit breaker (a state of the same deployment): `AWS_PROXY_ROLLOUT_FAILED`, not
 *   retryable, because the same revision would fail again.
 * - In progress, or not shown yet (no current deployment, or one of another revision: ECS's reads lag an update):
 *   `pending`, so a wait polls again and a deadline leaves it to a reconcile.
 * - A service ECS answers `MISSING` (deleted out of band, or just created and not shown yet): the update's mark is
 *   dropped, so the next pass's `ensureAwsProxyService` creates it, a repeat of the same token for a create that landed,
 *   and `pending`. A service already recorded as rolled out is not read again.
 */
export async function followAwsProxyRollout(
	input: AwsProxyRolloutInput,
): Promise<{ readonly namespace: ProviderDeploymentNamespace; readonly state: 'pending' | 'rolled' }> {
	try {
		return await rollout(input)
	} catch (error) {
		throw namespaceFailure(error)
	}
}

async function rollout(
	input: AwsProxyRolloutInput,
): Promise<{ readonly namespace: ProviderDeploymentNamespace; readonly state: 'pending' | 'rolled' }> {
	const { clients, installation, signal } = input
	let namespace = input.namespace
	const stored = checkNamespaceTarget(namespace, installation, input.proxySource)
	if (stored.proxyServiceRolledOut === true) return { namespace, state: 'rolled' }
	const revision = stored.proxyServiceTaskDefinitionArn
	if (revision === undefined || stored.proxyServiceUpdated !== true) {
		throw new Error("aws: the namespace's proxy service was not set to a revision to follow")
	}
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const record = async (target: AwsNamespaceTarget): Promise<void> => {
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(target) }
		await input.events.checkpoint(namespace)
	}

	const found = await clients.ecs.describeService({ cluster: installation.cluster, service: resources.service }, signal)
	if (found === null || found.status !== 'active') {
		const { proxyServiceUpdated: _updated, ...rest } = stored
		await record(rest)
		return { namespace, state: 'pending' }
	}
	if (found.currentDeploymentArn === null) return { namespace, state: 'pending' }
	const deployment = await clients.ecs.describeServiceDeployment(found.currentDeploymentArn, signal)
	if (deployment === null || deployment.targetRevisionArn === null) return { namespace, state: 'pending' }
	const target = await clients.ecs.describeServiceRevision(deployment.targetRevisionArn, signal)
	if (target === null || target.taskDefinitionArn !== revision) return { namespace, state: 'pending' }
	switch (deployment.status) {
		case 'pending':
		case 'in_progress':
		case 'stop_requested':
			return { namespace, state: 'pending' }
		case 'stopped':
		case 'rollback_requested':
		case 'rollback_in_progress':
		case 'rollback_successful':
		case 'rollback_failed':
			throw new ProviderNamespaceError(
				`aws: the proxy service ${resources.service}'s deployment of ${revision} is ${deployment.status}`,
				AWS_PROXY_ROLLOUT_FAILED,
				false,
			)
		case 'successful':
			break
	}

	// The revision serves: what it does not name is read by no task that may still start. The kept names are the
	// revision's own only if the members and key given are the ones it was set for, so its fingerprint is checked here.
	const secrets = awsProxySecrets(input.members, input.iam.key)
	if (
		stored.proxyImageDigest === undefined
		|| (await awsProxyServiceFingerprint(stored.proxyImageDigest, input.iam.issuer, secrets)) !== stored.proxyServiceFingerprint
	) {
		throw new Error("aws: the members given are not the ones the proxy's revision was set for; no secret is deleted")
	}
	const kept = new Set(Object.keys(secrets).map((name) => `${resources.parameterPath}/env/${name}`))
	// A failed delete fails the pass before the rollout is recorded, so the next one deletes again (a gone name is no error).
	for (const name of await clients.ssm.listNames(`${resources.parameterPath}/env`, signal)) {
		if (!kept.has(name)) await clients.ssm.deleteSecret(name, signal)
	}
	await record({ ...stored, proxyServiceRolledOut: true })
	return { namespace, state: 'rolled' }
}
