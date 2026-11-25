// The AWS provider's deployment namespaces (ADR-0014; the AWS idea's checklist, step 10): one CloudFormation stack per
// namespace, which Control creates and reconciles over the CloudFormation API, and which every environment placed in
// the namespace reads at deploy.
//
// - The stack holds the namespace proxy's security group, in the installation's VPC, and the Service Connect namespace
//   the proxy and its applications will share. The group admits nothing yet (the balancer's group comes with the
//   proxy); each environment's own stack admits the group on the application's port alone, so an application is
//   reachable from its namespace's proxy and from nothing else (ADR-0022 rule 5). The proxy secret still authenticates
//   the hop: a security group says which tasks may connect, not which request a proxy sent.
// - Every name is derived from the namespace's id and environment (`awsNamespaceResources`), never registered, and the
//   target holds the installation's account and region and the derived stack name, which `normalize` checks.
// - Claims: a namespace claims its stack; an environment placed in one claims its own stack, its service and its
//   parameter path, so a later registration of the same coordinates cannot inherit what an earlier one left
//   (ADR-0014). `claimedResources` reads each of them back, so Control releases a claim only over a resource gone.
//   fabrika deletes none of them (ADR-0034): an operator does.
// - Only `cheap` is offered: the namespace shares the installation's database once there is one. `full`, with its own
//   instance, comes with the database. No entry point follows the members yet: the proxy service, its manifest and the
//   balancer rule are not built, so there is no `republish`.
//
// UNVERIFIED: the resource types, their properties and their outputs follow CloudFormation's resource reference; none
// was checked against an account.

import {
	decodeEnvelope,
	type JsonValue,
	type ProviderClaimedResource,
	type ProviderDeploymentNamespace,
	type ProviderNamespaceCapabilities,
	ProviderNamespaceError,
	type ProviderNamespaceMutationInput,
	type ProviderNamespacePresentation,
	type ProviderRegistration,
} from '@fabrika/provider-contract'
import type { CloudFormationClient } from './aws/cloudformation'
import { type EcsClient, SERVICE_CONNECT_ARN } from './aws/ecs'
import type { SsmClient } from './aws/ssm'
import { AwsError } from './aws/transport'
import { AWS_PROVIDER, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from './codecs'
import type { AwsInstallationNetwork } from './environment-stack'
import { awsNamespaceMemberHosts } from './proxy-manifest'
import { awsEnvironmentResources } from './resources'
import { type AwsStack, AwsStackPending, ensureStack, readStackOutputs } from './stack'

/** A namespace id or environment name the derived names take: no `_`, `/` or `.`, as an application's. */
const NAME_PART = /^[a-z0-9][a-z0-9-]{0,62}$/
/** A CloudFormation stack's name holds at most 128 characters. */
const MAX_STACK_NAME = 128
/** The outputs of a namespace's stack, and their forms. */
const PROXY_SECURITY_GROUP_OUTPUT = 'ProxySecurityGroupId'
const SERVICE_CONNECT_OUTPUT = 'ServiceConnectNamespaceArn'
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/
/** The one preset this version offers. */
export const AWS_CHEAP_PRESET = 'cheap'

/** One namespace's own AWS resources, named from its id and environment alone. */
export interface AwsNamespaceResources {
	/** The stack, `fabrika-ns-<length of id>-<id>-<env>`: the length keeps a hyphen in the id apart from the joining one. */
	readonly stackName: string
	/** The Service Connect (Cloud Map) namespace, named as the stack. */
	readonly serviceConnectNamespace: string
}

/** The names of a namespace's resources; an id or environment outside `NAME_PART`, or a name past AWS's bound, is refused. */
export function awsNamespaceResources(id: string, env: string): AwsNamespaceResources {
	if (!NAME_PART.test(id) || !NAME_PART.test(env)) {
		throw new Error('aws: the namespace id or environment name is not one this provider names resources by')
	}
	const stackName = `fabrika-ns-${id.length}-${id}-${env}`
	if (stackName.length > MAX_STACK_NAME) throw new Error('aws: the namespace id and environment name are too long for a stack name')
	return { stackName, serviceConnectNamespace: stackName }
}

/** What a namespace's stack created under names AWS chose, which every deploy into the namespace reads. */
export interface AwsNamespaceOutputs {
	readonly proxySecurityGroupId: string
	readonly serviceConnectNamespaceArn: string
}

/** The stack of one namespace in the installation's VPC. */
export function awsNamespaceStack(
	namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>,
	network: Pick<AwsInstallationNetwork, 'vpcId'>,
): AwsStack {
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const tags = [{ Key: 'fabrika:namespace', Value: namespace.id }, { Key: 'fabrika:env', Value: namespace.env }]
	const template: JsonValue = {
		AWSTemplateFormatVersion: '2010-09-09',
		Description: `fabrika: the deployment namespace ${namespace.id}/${namespace.env}`,
		Resources: {
			ProxySecurityGroup: {
				Type: 'AWS::EC2::SecurityGroup',
				Properties: {
					GroupDescription: `fabrika: the proxy of ${namespace.id}/${namespace.env}`,
					VpcId: network.vpcId,
					// No ingress rule yet: the balancer's group is admitted with the proxy service. The proxy reaches out to its
					// applications (each admits this group on its port), to IAM and to the image registry.
					SecurityGroupEgress: [{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'outbound' }],
					Tags: tags,
				},
			},
			ServiceConnect: {
				Type: 'AWS::ServiceDiscovery::HttpNamespace',
				Properties: { Name: resources.serviceConnectNamespace, Description: `fabrika: ${namespace.id}/${namespace.env}`, Tags: tags },
			},
		},
		Outputs: {
			[PROXY_SECURITY_GROUP_OUTPUT]: { Value: { 'Fn::GetAtt': ['ProxySecurityGroup', 'GroupId'] } },
			[SERVICE_CONNECT_OUTPUT]: { Value: { 'Fn::GetAtt': ['ServiceConnect', 'Arn'] } },
		},
	}
	return { stackName: resources.stackName, template, tags: { 'fabrika:namespace': namespace.id, 'fabrika:env': namespace.env } }
}

/** The outputs the namespace's template declares, each of its form. */
export function namespaceOutputsOf(name: string, outputs: Readonly<Record<string, string>>): AwsNamespaceOutputs {
	const proxySecurityGroupId = outputs[PROXY_SECURITY_GROUP_OUTPUT] ?? ''
	const serviceConnectNamespaceArn = outputs[SERVICE_CONNECT_OUTPUT] ?? ''
	if (!SECURITY_GROUP_ID.test(proxySecurityGroupId) || !SERVICE_CONNECT_ARN.test(serviceConnectNamespaceArn)) {
		throw new Error(`aws: the stack ${name} names no proxy security group or Service Connect namespace of the form AWS gives one`)
	}
	return { proxySecurityGroupId, serviceConnectNamespaceArn }
}

/** The calls the namespace lifecycle makes. */
export interface AwsNamespaceClients {
	readonly cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack' | 'getTemplate' | 'createStack' | 'updateStack'>
	readonly ecs: Pick<EcsClient, 'describeService'>
	readonly ssm: Pick<SsmClient, 'listNames'>
}

export interface AwsNamespaceOptions {
	/** The installation's coordinates and network: Control's configuration, which every namespace is checked against. */
	readonly installation: AwsAppTarget
	readonly network: AwsInstallationNetwork
	readonly clients: AwsNamespaceClients
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly now?: () => number
}

/** The claim keys, by kind: `stack:<name>`, `service:<cluster>/<service>`, `parameters:<path>`. */
const STACK_CLAIM = 'stack:'
const SERVICE_CLAIM = 'service:'
const PARAMETERS_CLAIM = 'parameters:'

/** A namespace's target as this installation must hold it, or an error naming the field that differs. */
export function checkNamespaceTarget(namespace: ProviderDeploymentNamespace, installation: AwsAppTarget): AwsNamespaceTarget {
	const target = decodeEnvelope('namespace target', AWS_PROVIDER, namespace.target, awsNamespaceTargetCodec)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	if (target.accountId !== installation.accountId || target.region !== installation.region) {
		throw new Error("aws: the namespace's target names another account or region than this installation's")
	}
	if (target.stackName !== resources.stackName) throw new Error("aws: the namespace's target names another stack than its id and environment derive")
	if (target.sizing !== AWS_CHEAP_PRESET) throw new Error('aws: only a cheap namespace is provisioned on AWS yet')
	return target
}

/** The canonical target of a namespace of this installation. */
function targetOf(namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>, installation: AwsAppTarget): ProviderDeploymentNamespace['target'] {
	const target: AwsNamespaceTarget = {
		accountId: installation.accountId,
		region: installation.region,
		stackName: awsNamespaceResources(namespace.id, namespace.env).stackName,
		sizing: AWS_CHEAP_PRESET,
	}
	return { provider: AWS_PROVIDER, version: awsNamespaceTargetCodec.version, payload: awsNamespaceTargetCodec.encode(target) }
}

/**
 * A lifecycle failure as Control records it: a stable code, the summary, never an error object. A stack CloudFormation
 * is still working on is retryable (`awsStackPending`), so Control leaves the namespace provisioning and a later
 * reconcile settles it; `awsStack` is a stack only an operator or a new template repairs.
 */
function namespaceFailure(error: unknown): ProviderNamespaceError {
	if (error instanceof ProviderNamespaceError) return error
	if (error instanceof AwsStackPending) return new ProviderNamespaceError(error.message, 'awsStackPending', true)
	if (error instanceof AwsError) return new ProviderNamespaceError(`aws: ${error.operation} failed (${error.code})`, 'awsCall', error.retryable)
	const message = error instanceof Error ? error.message : 'aws: the namespace stack could not be applied'
	return new ProviderNamespaceError(message, 'awsStack', false)
}

/** The namespace capabilities over this installation's account. */
export function awsNamespaceCapabilities(options: AwsNamespaceOptions): ProviderNamespaceCapabilities {
	const { installation, network, clients } = options

	const present = (namespace: ProviderDeploymentNamespace): ProviderNamespacePresentation => {
		const resources = awsNamespaceResources(namespace.id, namespace.env)
		return {
			preset: AWS_CHEAP_PRESET,
			title: `AWS namespace ${namespace.id}`,
			facts: [
				{ label: 'Region', value: installation.region },
				{ label: 'Stack', value: resources.stackName, resource: true },
				{ label: 'Service Connect namespace', value: resources.serviceConnectNamespace, resource: true },
			],
			instructions: [
				'Control creates the stack. Removing the namespace leaves it in place: delete the stack when no environment uses it.',
			],
		}
	}

	const apply = async (input: ProviderNamespaceMutationInput): Promise<ProviderDeploymentNamespace> => {
		try {
			checkNamespaceTarget(input.namespace, installation)
		} catch (error) {
			throw new ProviderNamespaceError(error instanceof Error ? error.message : 'aws: the namespace target is refused', 'awsTarget', false)
		}
		try {
			await ensureStack({
				cloudFormation: clients.cloudFormation,
				stack: awsNamespaceStack(input.namespace, network),
				signal: input.signal,
				sleep: options.sleep,
				...(options.now === undefined ? {} : { now: options.now }),
				log: () => {},
			})
		} catch (error) {
			throw namespaceFailure(error)
		}
		return { ...input.namespace, target: targetOf(input.namespace, installation) }
	}

	const claimGone = async (key: string, signal: AbortSignal): Promise<boolean> => {
		if (key.startsWith(STACK_CLAIM)) return (await clients.cloudFormation.findStack(key.slice(STACK_CLAIM.length), signal)) === null
		if (key.startsWith(SERVICE_CLAIM)) {
			const [cluster = '', service = ''] = key.slice(SERVICE_CLAIM.length).split('/')
			const found = await clients.ecs.describeService({ cluster, service }, signal)
			return found === null || found.status === 'inactive'
		}
		if (key.startsWith(PARAMETERS_CLAIM)) {
			// The run's secrets are the parameters an earlier registration could hand on; the build's URL parameters are
			// deleted by each build and expire with their URL.
			return (await clients.ssm.listNames(`${key.slice(PARAMETERS_CLAIM.length)}/env`, signal)).length === 0
		}
		throw new Error('aws: a claim of a kind this provider does not make')
	}

	return {
		normalize: (namespace) => {
			// A target is the installation's, never a caller's: one of another form or for another account is refused.
			checkNamespaceTarget(namespace, installation)
			return { ...namespace, target: targetOf(namespace, installation) }
		},
		namespaceResourceClaims: (namespace) => [`${STACK_CLAIM}${awsNamespaceResources(namespace.id, namespace.env).stackName}`],
		// The hosts the proxy will route a member on, by its manifest's rule, so Control refuses two members on one host now.
		memberHosts: awsNamespaceMemberHosts,
		registrationResourceClaims: (registration: ProviderRegistration) => {
			const { appId, env } = registration.environment
			const resources = awsEnvironmentResources(appId, env, installation.accountId)
			return [
				`${STACK_CLAIM}${resources.stackName}`,
				`${SERVICE_CLAIM}${installation.cluster}/${resources.service}`,
				`${PARAMETERS_CLAIM}${resources.parameterPath}`,
			]
		},
		provision: apply,
		reconcile: apply,
		claimedResources: async ({ resourceKeys, signal }): Promise<readonly ProviderClaimedResource[]> => {
			const answers: ProviderClaimedResource[] = []
			for (const resourceKey of resourceKeys) answers.push({ resourceKey, exists: !(await claimGone(resourceKey, signal)) })
			return answers
		},
		operator: {
			presets: [{
				id: AWS_CHEAP_PRESET,
				label: 'Cheap',
				description: "A shared namespace: one proxy for its applications, in the installation's network.",
				requiresExclusiveApp: false,
			}],
			plan: (input) => {
				if (input.preset !== AWS_CHEAP_PRESET) throw new Error('aws: only the cheap preset is offered on AWS yet')
				if (input.options !== undefined) throw new Error('aws: a cheap namespace takes no options')
				const namespace: ProviderDeploymentNamespace = {
					id: input.id,
					env: input.env,
					...(input.exclusiveAppId === undefined ? {} : { exclusiveAppId: input.exclusiveAppId }),
					target: targetOf(input, installation),
				}
				return { namespace, presentation: present(namespace) }
			},
			present,
		},
	}
}

/**
 * The outputs of the namespace an environment is placed in, for its deploy: the namespace must be this installation's
 * and its stack must serve. A namespace whose stack is absent or still moving is refused, naming the remedy.
 */
export async function readNamespaceOutputs(
	cloudFormation: Pick<CloudFormationClient, 'findStack' | 'describeStack'>,
	namespace: ProviderDeploymentNamespace,
	installation: AwsAppTarget,
	signal: AbortSignal,
): Promise<AwsNamespaceOutputs> {
	const target = checkNamespaceTarget(namespace, installation)
	let outputs: Readonly<Record<string, string>> | null
	try {
		outputs = await readStackOutputs(cloudFormation, target.stackName, signal)
	} catch (error) {
		// A deploy takes no namespace lease, so it may meet a reconcile at work on the stack: it says so and what to do.
		if (error instanceof AwsStackPending) {
			throw new Error(`aws: the namespace ${namespace.id}'s stack is being created or updated (a reconcile is at work); deploy again once it serves`)
		}
		throw error
	}
	if (outputs === null) throw new Error(`aws: the namespace ${namespace.id} has no stack yet; reconcile the namespace, then deploy again`)
	return namespaceOutputsOf(target.stackName, outputs)
}
