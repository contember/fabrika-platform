// The AWS provider's deployment namespaces (ADR-0014; the AWS idea's checklist, step 10): one CloudFormation stack per
// namespace, which Control creates and reconciles over the CloudFormation API, and which every environment placed in
// the namespace reads at deploy.
//
// - The stack holds the namespace proxy's security group, in the installation's VPC, and the Service Connect namespace
//   the proxy and its applications will share. The group admits nothing yet (the balancer's group comes with the
//   proxy); each environment's own stack admits the group on the application's port alone, so an application is
//   reachable from its namespace's proxy and from nothing else (ADR-0022 rule 5). The proxy secret still authenticates
//   the hop: a security group says which tasks may connect, not which request a proxy sent.
// - It holds what builds the proxy's image too (`proxy-build.ts`): the proxy's repository, the namespace's own CodeBuild
//   project, its log group and its role, which carries the installation's permissions boundary as every role Control's
//   stacks create, and reaches this namespace's repository, `builds/` parameters and build log group alone. Their names
//   live under `fabrika/namespaces/`, apart from every application environment's (`fabrika/apps/`).
// - Every name is derived from the namespace's id and environment (`awsNamespaceResources`), never registered, and the
//   target holds the installation's account and region and the derived stack name, which `normalize` checks.
// - Claims: a namespace claims its stack; an environment placed in one claims its own stack, its service and its
//   parameter path, so a later registration of the same coordinates cannot inherit what an earlier one left
//   (ADR-0014). `claimedResources` reads each of them back, so Control releases a claim only over a resource gone.
//   fabrika deletes none of them (ADR-0034): an operator does.
// - Only `cheap` is offered: the namespace shares the installation's database once there is one. `full`, with its own
//   instance, comes with the database. No entry point follows the members yet: the proxy's manifest is compiled
//   (`proxy-manifest.ts`) and its build declared, but nothing starts a build, and the proxy service and the balancer rule
//   are not built, so there is no `republish`.
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
import { ecrLifecyclePolicy } from './aws/ecr'
import { type EcsClient, SERVICE_CONNECT_ARN } from './aws/ecs'
import type { SsmClient } from './aws/ssm'
import { AwsError } from './aws/transport'
import { AWS_PROVIDER, type AwsAppTarget, type AwsNamespaceTarget, awsNamespaceTargetCodec } from './codecs'
import { allow, AWS_LOG_RETENTION_DAYS, awsAppsPermissionsBoundary, type AwsInstallationNetwork, policy, trust } from './environment-stack'
import { AWS_PROXY_BUILD_IMAGE, AWS_PROXY_BUILDSPEC } from './proxy-build'
import { awsNamespaceMemberHosts } from './proxy-manifest'
import { AWS_KEPT_IMAGES, awsEnvironmentResources } from './resources'
import { AWS_BUILD_QUEUED_TIMEOUT_MINUTES, AWS_BUILD_TIMEOUT_MINUTES } from './run-attempt'
import { type AwsStack, AwsStackPending, ensureStack, readStackOutputs } from './stack'

/**
 * A namespace id or environment name the derived names take: no `_`, `/` or `.`, as an application's, and hyphens only
 * between letters or digits, so each is a segment of an ECR repository's name.
 */
const NAME_PART = /^(?=.{1,63}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** A CloudFormation stack's name holds at most 128 characters; an IAM role's 64. */
const MAX_STACK_NAME = 128
const MAX_ROLE_NAME = 64
/**
 * The longest role name a namespace will hold, the proxy task's execution role (with its service), checked now, so
 * adding that role never refuses a namespace this version takes.
 */
const LONGEST_ROLE_SUFFIX = '_proxy_execution'
const IAM_PATH = '/fabrika/namespaces/'
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
	/** The proxy's image repository, `fabrika/namespaces/<id>/<env>/proxy`. */
	readonly repository: string
	/** The namespace's parameter path, `/fabrika/namespaces/<id>/<env>`: the proxy build's source URLs under `builds/`. */
	readonly parameterPath: string
	/** The proxy's CodeBuild project, `fabrika_ns_<id>_<env>`, its role's name (under `/fabrika/namespaces/`) and its log group. */
	readonly buildProject: string
	readonly buildRoleName: string
	readonly buildLogGroup: string
	/**
	 * Where the proxy's archives go in the sources bucket, `sources/namespaces/<id>/<env>`: below Control's `sources/`
	 * grant, and a part more than an application environment's (`sources/<app>/<env>`), so the two never meet.
	 */
	readonly sourcePrefix: string
}

/**
 * The names of a namespace's resources; an id or environment outside `NAME_PART`, or a name past AWS's bound, is refused.
 *
 * None can be an application environment's (`resources.ts`): those live under `fabrika/apps/` (the repository, the
 * parameters, the log groups and the roles' path), and a role or project name of an application joins exactly two parts
 * with `_` (`<app>_<env>_build`, `fabrika_<app>_<env>`), where a namespace's joins more (`<id>_<env>_proxy_build`,
 * `fabrika_ns_<id>_<env>`). No part holds `_`. IAM role names are unique per account, whatever their path.
 */
export function awsNamespaceResources(id: string, env: string): AwsNamespaceResources {
	if (!NAME_PART.test(id) || !NAME_PART.test(env)) {
		throw new Error('aws: the namespace id or environment name is not one this provider names resources by')
	}
	const stackName = `fabrika-ns-${id.length}-${id}-${env}`
	if (stackName.length > MAX_STACK_NAME) throw new Error('aws: the namespace id and environment name are too long for a stack name')
	const role = `${id}_${env}`
	if (`${role}${LONGEST_ROLE_SUFFIX}`.length > MAX_ROLE_NAME) {
		throw new Error('aws: the namespace id and environment name are too long for an IAM role name')
	}
	return {
		stackName,
		serviceConnectNamespace: stackName,
		repository: `fabrika/namespaces/${id}/${env}/proxy`,
		parameterPath: `/fabrika/namespaces/${id}/${env}`,
		buildProject: `fabrika_ns_${role}`,
		buildRoleName: `${role}_proxy_build`,
		buildLogGroup: `/fabrika/namespaces/${id}/${env}/proxy/build`,
		sourcePrefix: `sources/namespaces/${id}/${env}`,
	}
}

/** What a namespace's stack created under names AWS chose, which every deploy into the namespace reads. */
export interface AwsNamespaceOutputs {
	readonly proxySecurityGroupId: string
	readonly serviceConnectNamespaceArn: string
}

/** The stack of one namespace of `installation`, in the installation's VPC. */
export function awsNamespaceStack(
	namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>,
	installation: Pick<AwsAppTarget, 'accountId' | 'region'>,
	network: Pick<AwsInstallationNetwork, 'vpcId'>,
): AwsStack {
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const { accountId, region } = installation
	const tags = [{ Key: 'fabrika:namespace', Value: namespace.id }, { Key: 'fabrika:env', Value: namespace.env }]
	const repositoryArn = `arn:aws:ecr:${region}:${accountId}:repository/${resources.repository}`
	const project = `arn:aws:codebuild:${region}:${accountId}:project/${resources.buildProject}`
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
			// The proxy's image: built from the namespace's pinned commit and its manifest (`proxy-build.ts`), one per attempt.
			// Emptied when the stack is deleted, which CloudFormation otherwise refuses for a repository that holds images: every
			// image is derived and rebuilt from the pinned source, so the operator's delete of the stack loses nothing.
			ProxyRepository: {
				Type: 'AWS::ECR::Repository',
				Properties: {
					RepositoryName: resources.repository,
					EmptyOnDelete: true,
					ImageTagMutability: 'IMMUTABLE',
					EncryptionConfiguration: { EncryptionType: 'AES256' },
					LifecyclePolicy: { LifecyclePolicyText: ecrLifecyclePolicy(AWS_KEPT_IMAGES) },
					Tags: tags,
				},
			},
			ProxyBuildLogGroup: {
				Type: 'AWS::Logs::LogGroup',
				Properties: { LogGroupName: resources.buildLogGroup, RetentionInDays: AWS_LOG_RETENTION_DAYS, Tags: tags },
			},
			// The build's role, under the installation's boundary as every role Control's stacks create: it pushes to this
			// namespace's repository, reads this namespace's source URL parameters and writes its own log group, nothing else.
			// Only this namespace's project may take it.
			ProxyBuildRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: resources.buildRoleName,
					Path: IAM_PATH,
					PermissionsBoundary: awsAppsPermissionsBoundary(accountId),
					AssumeRolePolicyDocument: trust('codebuild.amazonaws.com', accountId, { equals: project }),
					Policies: [
						policy('build', [
							// ECR issues its login token per account; the action takes no resource.
							allow(['ecr:GetAuthorizationToken'], ['*']),
							allow(
								['ecr:BatchCheckLayerAvailability', 'ecr:InitiateLayerUpload', 'ecr:UploadLayerPart', 'ecr:CompleteLayerUpload', 'ecr:PutImage'],
								[repositoryArn],
							),
							allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${region}:${accountId}:log-group:${resources.buildLogGroup}:*`]),
							allow(['ssm:GetParameters'], [`arn:aws:ssm:${region}:${accountId}:parameter${resources.parameterPath}/builds/*`]),
						]),
					],
					Tags: tags,
				},
			},
			// The namespace's own project, so no proxy build reaches another namespace's images; an x86 builder, as the
			// proxy's binary is an x64 one. Each start sends the same buildspec and its attempt's variables.
			ProxyBuildProject: {
				Type: 'AWS::CodeBuild::Project',
				Properties: {
					Name: resources.buildProject,
					ServiceRole: { 'Fn::GetAtt': ['ProxyBuildRole', 'Arn'] },
					Source: { Type: 'NO_SOURCE', BuildSpec: AWS_PROXY_BUILDSPEC },
					Artifacts: { Type: 'NO_ARTIFACTS' },
					Environment: {
						Type: 'LINUX_CONTAINER',
						ComputeType: 'BUILD_GENERAL1_SMALL',
						Image: AWS_PROXY_BUILD_IMAGE,
						// The build runs Docker to build the image.
						PrivilegedMode: true,
					},
					LogsConfig: { CloudWatchLogs: { Status: 'ENABLED', GroupName: resources.buildLogGroup } },
					TimeoutInMinutes: AWS_BUILD_TIMEOUT_MINUTES,
					QueuedTimeoutInMinutes: AWS_BUILD_QUEUED_TIMEOUT_MINUTES,
					Tags: tags,
				},
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

/**
 * The source a namespace's proxy is built from: the installation's public platform repository and a full commit. The
 * installation's is Control's configuration, its default for a namespace being planned (ADR-0045).
 */
export interface AwsProxySource {
	readonly repository: { readonly owner: string; readonly name: string }
	readonly commitSha: string
}

export interface AwsNamespaceOptions {
	/** The installation's coordinates and network: Control's configuration, which every namespace is checked against. */
	readonly installation: AwsAppTarget
	readonly network: AwsInstallationNetwork
	/** The installation's proxy source: a planned namespace's pin, and the only repository any pin may name. */
	readonly proxySource: AwsProxySource
	readonly clients: AwsNamespaceClients
	readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
	readonly now?: () => number
}

/** The claim keys, by kind: `stack:<name>`, `service:<cluster>/<service>`, `parameters:<path>`. */
const STACK_CLAIM = 'stack:'
const SERVICE_CLAIM = 'service:'
const PARAMETERS_CLAIM = 'parameters:'

/** A namespace's target as this installation must hold it, or an error naming the field that differs. */
export function checkNamespaceTarget(
	namespace: ProviderDeploymentNamespace,
	installation: AwsAppTarget,
	proxySource: AwsProxySource,
): AwsNamespaceTarget {
	const target = decodeEnvelope('namespace target', AWS_PROVIDER, namespace.target, awsNamespaceTargetCodec)
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	if (target.accountId !== installation.accountId || target.region !== installation.region) {
		throw new Error("aws: the namespace's target names another account or region than this installation's")
	}
	if (target.stackName !== resources.stackName) throw new Error("aws: the namespace's target names another stack than its id and environment derive")
	if (target.sizing !== AWS_CHEAP_PRESET) throw new Error('aws: only a cheap namespace is provisioned on AWS yet')
	// The proxy is the installation's enforcement point: it is built from the installation's platform repository alone.
	// The commit may be an older one than the installation's default: a pin outlives an upgrade (ADR-0045).
	if (target.proxyRepository !== awsProxyRepositoryName(proxySource)) {
		throw new Error("aws: the namespace's proxy is pinned to another repository than this installation's platform repository")
	}
	return target
}

/** `<owner>/<name>` of the installation's platform repository, as a namespace's target records it. */
export function awsProxyRepositoryName(proxySource: AwsProxySource): string {
	return `${proxySource.repository.owner}/${proxySource.repository.name}`
}

/**
 * The canonical target of a namespace of this installation. `stored` is the namespace's own target, whose pin and proxy
 * build in flight it keeps; absent (a namespace being planned), the pin is the installation's default.
 */
function targetOf(
	namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>,
	installation: AwsAppTarget,
	proxySource: AwsProxySource,
	stored?: AwsNamespaceTarget,
): ProviderDeploymentNamespace['target'] {
	const target: AwsNamespaceTarget = {
		accountId: installation.accountId,
		region: installation.region,
		stackName: awsNamespaceResources(namespace.id, namespace.env).stackName,
		sizing: AWS_CHEAP_PRESET,
		proxyRepository: stored?.proxyRepository ?? awsProxyRepositoryName(proxySource),
		proxyCommitSha: stored?.proxyCommitSha ?? proxySource.commitSha,
		...(stored?.proxyBuildToken === undefined ? {} : { proxyBuildToken: stored.proxyBuildToken }),
		...(stored?.proxyBuildManifestSha256 === undefined ? {} : { proxyBuildManifestSha256: stored.proxyBuildManifestSha256 }),
		...(stored?.proxyBuildId === undefined ? {} : { proxyBuildId: stored.proxyBuildId }),
	}
	return awsNamespaceTargetEnvelope(target)
}

/** A namespace target as Control stores it. */
export function awsNamespaceTargetEnvelope(target: AwsNamespaceTarget): ProviderDeploymentNamespace['target'] {
	return { provider: AWS_PROVIDER, version: awsNamespaceTargetCodec.version, payload: awsNamespaceTargetCodec.encode(target) }
}

/**
 * A lifecycle failure as Control records it: a stable code, the summary, never an error object. A stack CloudFormation
 * is still working on is retryable (`awsStackPending`), so Control leaves the namespace provisioning and a later
 * reconcile settles it; `awsStack` is a stack only an operator or a new template repairs.
 */
export function namespaceFailure(error: unknown): ProviderNamespaceError {
	if (error instanceof ProviderNamespaceError) return error
	if (error instanceof AwsStackPending) return new ProviderNamespaceError(error.message, 'awsStackPending', true)
	if (error instanceof AwsError) return new ProviderNamespaceError(`aws: ${error.operation} failed (${error.code})`, 'awsCall', error.retryable)
	const message = error instanceof Error ? error.message : 'aws: the namespace stack could not be applied'
	return new ProviderNamespaceError(message, 'awsStack', false)
}

/** The namespace capabilities over this installation's account. */
export function awsNamespaceCapabilities(options: AwsNamespaceOptions): ProviderNamespaceCapabilities {
	const { installation, network, clients, proxySource } = options

	const present = (namespace: ProviderDeploymentNamespace): ProviderNamespacePresentation => {
		const resources = awsNamespaceResources(namespace.id, namespace.env)
		const target = awsNamespaceTargetCodec.decode(namespace.target.payload)
		return {
			preset: AWS_CHEAP_PRESET,
			title: `AWS namespace ${namespace.id}`,
			facts: [
				{ label: 'Region', value: installation.region },
				{ label: 'Stack', value: resources.stackName, resource: true },
				{ label: 'Service Connect namespace', value: resources.serviceConnectNamespace, resource: true },
				{ label: 'Proxy image repository', value: resources.repository, resource: true },
				{ label: 'Proxy build project', value: resources.buildProject, resource: true },
				// A policy choice, not a resource: the pin the proxy is built from until an operator moves it.
				{ label: 'Proxy source', value: `${target.proxyRepository}@${target.proxyCommitSha}` },
			],
			instructions: [
				'Control creates the stack. Removing the namespace leaves it in place: delete the stack when no environment uses it.',
				"Deleting the stack deletes the proxy's images with their repository: they are rebuilt from the namespace's pinned source.",
			],
		}
	}

	const apply = async (input: ProviderNamespaceMutationInput): Promise<ProviderDeploymentNamespace> => {
		let stored: AwsNamespaceTarget
		try {
			stored = checkNamespaceTarget(input.namespace, installation, proxySource)
		} catch (error) {
			throw new ProviderNamespaceError(error instanceof Error ? error.message : 'aws: the namespace target is refused', 'awsTarget', false)
		}
		try {
			await ensureStack({
				cloudFormation: clients.cloudFormation,
				stack: awsNamespaceStack(input.namespace, installation, network),
				signal: input.signal,
				sleep: options.sleep,
				...(options.now === undefined ? {} : { now: options.now }),
				log: () => {},
			})
		} catch (error) {
			throw namespaceFailure(error)
		}
		return { ...input.namespace, target: targetOf(input.namespace, installation, proxySource, stored) }
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
			// A target is the installation's, never a caller's: one of another form or for another account is refused. Its pin
			// is kept as it is, never moved to a newer default (ADR-0045).
			const stored = checkNamespaceTarget(namespace, installation, proxySource)
			return { ...namespace, target: targetOf(namespace, installation, proxySource, stored) }
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
					target: targetOf(input, installation, proxySource),
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
	proxySource: AwsProxySource,
	signal: AbortSignal,
): Promise<AwsNamespaceOutputs> {
	const target = checkNamespaceTarget(namespace, installation, proxySource)
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
