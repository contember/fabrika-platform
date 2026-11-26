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
	type ProviderNamespaceFact,
	type ProviderNamespaceMember,
	type ProviderNamespaceMutationInput,
	type ProviderNamespacePresentation,
	type ProviderRegistration,
} from '@fabrika/provider-contract'
import { CERTIFICATE_HOST } from './aws/acm'
import type { CloudFormationClient } from './aws/cloudformation'
import { ecrLifecyclePolicy } from './aws/ecr'
import { type EcsClient, SERVICE_CONNECT_ARN, TARGET_GROUP_ARN } from './aws/ecs'
import { LISTENER_ARN } from './aws/elb'
import type { SsmClient } from './aws/ssm'
import { AwsError } from './aws/transport'
import {
	AWS_MAX_PROXY_CERTIFICATES,
	AWS_PROVIDER,
	type AwsAppTarget,
	type AwsNamespaceTarget,
	awsNamespaceTargetCodec,
	type AwsProxyHostsFailure,
} from './codecs'
import { AWS_APPLICATION_PORT } from './ecs-task'
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
const PROXY_TARGET_GROUP_OUTPUT = 'ProxyTargetGroupArn'
const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/
/** The proxy's public listener and its health listener with its path (`packages/proxy/src/caddy.ts`'s defaults). */
export const AWS_PROXY_PORT = 8080
export const AWS_PROXY_HEALTH_PORT = 8081
export const AWS_PROXY_HEALTH_PATH = '/healthz'
/** The one preset this version offers. */
export const AWS_CHEAP_PRESET = 'cheap'

/** One namespace's own AWS resources, named from its id and environment alone. */
export interface AwsNamespaceResources {
	/** The stack, `fabrika-ns-<length of id>-<id>-<env>`: the length keeps a hyphen in the id apart from the joining one. */
	readonly stackName: string
	/**
	 * The hosts stack, `fabrika-nh-<length of id>-<id>-<env>` (`proxy-hosts.ts`): the namespace's rules on the
	 * installation's listener. A prefix of its own, so no namespace's stack name (an environment may end in `-hosts`) is
	 * ever another namespace's hosts stack.
	 */
	readonly hostsStackName: string
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
	 * Where the proxy's archives go in the sources bucket, `sources/_namespaces/<id>/<env>`: below Control's `sources/`
	 * grant, under a segment no application id can take (`_` is not in one), so no application environment's prefix
	 * (`sources/<app>/<env>`) holds a namespace's archives, nor the other way round.
	 */
	readonly sourcePrefix: string
	/**
	 * The proxy's ECS service, `ns_<id>_<env>_proxy`, which is its task definition's family too: more parts than an
	 * application's `<app>_<env>`, so the two never share a name in the cluster. Its log group, and its two roles: the
	 * task role (no permission: the proxy calls no AWS API) and the execution role, never one role (ADR-0004).
	 */
	readonly service: string
	readonly logGroup: string
	readonly taskRoleName: string
	readonly executionRoleName: string
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
		// The same length as the namespace's stack name, so the bound above holds for both.
		hostsStackName: `fabrika-nh-${id.length}-${id}-${env}`,
		serviceConnectNamespace: stackName,
		repository: `fabrika/namespaces/${id}/${env}/proxy`,
		parameterPath: `/fabrika/namespaces/${id}/${env}`,
		buildProject: `fabrika_ns_${role}`,
		buildRoleName: `${role}_proxy_build`,
		buildLogGroup: `/fabrika/namespaces/${id}/${env}/proxy/build`,
		sourcePrefix: `sources/_namespaces/${id}/${env}`,
		service: `ns_${role}_proxy`,
		logGroup: `/fabrika/namespaces/${id}/${env}/proxy`,
		taskRoleName: `${role}_proxy_task`,
		executionRoleName: `${role}${LONGEST_ROLE_SUFFIX}`,
	}
}

/** What a namespace's stack created under names AWS chose, which every deploy into the namespace reads. */
export interface AwsNamespaceOutputs {
	readonly proxySecurityGroupId: string
	readonly serviceConnectNamespaceArn: string
	/** The balancer's target group of the namespace's proxy. */
	readonly proxyTargetGroupArn: string
}

/** The stack of one namespace of `installation`, in the installation's VPC. */
export function awsNamespaceStack(
	namespace: Pick<ProviderDeploymentNamespace, 'id' | 'env'>,
	installation: Pick<AwsAppTarget, 'accountId' | 'region'>,
	network: Pick<AwsInstallationNetwork, 'vpcId'>,
	balancer: AwsInstallationBalancer,
): AwsStack {
	const resources = awsNamespaceResources(namespace.id, namespace.env)
	const { accountId, region } = installation
	const tags = [{ Key: 'fabrika:namespace', Value: namespace.id }, { Key: 'fabrika:env', Value: namespace.env }]
	const repositoryArn = `arn:aws:ecr:${region}:${accountId}:repository/${resources.repository}`
	const project = `arn:aws:codebuild:${region}:${accountId}:project/${resources.buildProject}`
	// ECS names the task it takes a role for; any of this account and region, and only of ECS.
	const ecs = { like: `arn:aws:ecs:${region}:${accountId}:*` }
	const template: JsonValue = {
		AWSTemplateFormatVersion: '2010-09-09',
		Description: `fabrika: the deployment namespace ${namespace.id}/${namespace.env}`,
		Resources: {
			ProxySecurityGroup: {
				Type: 'AWS::EC2::SecurityGroup',
				Properties: {
					GroupDescription: `fabrika: the proxy of ${namespace.id}/${namespace.env}`,
					VpcId: network.vpcId,
					// Only the balancer reaches the proxy: its requests on the public port, its health checks on the health one.
					SecurityGroupIngress: [
						{
							IpProtocol: 'tcp',
							FromPort: AWS_PROXY_PORT,
							ToPort: AWS_PROXY_PORT,
							SourceSecurityGroupId: balancer.securityGroupId,
							Description: 'the balancer',
						},
						{
							IpProtocol: 'tcp',
							FromPort: AWS_PROXY_HEALTH_PORT,
							ToPort: AWS_PROXY_HEALTH_PORT,
							SourceSecurityGroupId: balancer.securityGroupId,
							Description: "the balancer's health checks",
						},
					],
					// The proxy dials its applications in the VPC (each admits this group on its port), and IAM, the image
					// registry and the log service over HTTPS. The VPC's resolver answers outside any security group's rules.
					SecurityGroupEgress: [
						{ IpProtocol: 'tcp', FromPort: AWS_APPLICATION_PORT, ToPort: AWS_APPLICATION_PORT, CidrIp: balancer.vpcCidr, Description: 'the applications' },
						{ IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '0.0.0.0/0', Description: 'HTTPS: IAM, the image registry, logs' },
					],
					Tags: tags,
				},
			},
			// The balancer's target group of this namespace's proxy: its tasks by address on the public port, healthy when the
			// health listener answers. The installation's listener routes each member's host here (its rules come with the
			// certificates). Named by CloudFormation: a target group's name holds at most 32 characters.
			ProxyTargetGroup: {
				Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
				Properties: {
					TargetType: 'ip',
					Protocol: 'HTTP',
					Port: AWS_PROXY_PORT,
					VpcId: network.vpcId,
					HealthCheckProtocol: 'HTTP',
					HealthCheckPort: String(AWS_PROXY_HEALTH_PORT),
					HealthCheckPath: AWS_PROXY_HEALTH_PATH,
					Matcher: { HttpCode: '200' },
					// A task being replaced finishes its requests for this long; the default is five minutes.
					TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
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
			ProxyLogGroup: {
				Type: 'AWS::Logs::LogGroup',
				Properties: { LogGroupName: resources.logGroup, RetentionInDays: AWS_LOG_RETENTION_DAYS, Tags: tags },
			},
			// The proxy's own code runs as this role, which may call nothing: the proxy reaches IAM over HTTPS with its key and
			// its applications through Service Connect, never an AWS API. Only ECS in this account and region may take it.
			ProxyTaskRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: resources.taskRoleName,
					Path: IAM_PATH,
					PermissionsBoundary: awsAppsPermissionsBoundary(accountId),
					AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', accountId, ecs),
					Tags: tags,
				},
			},
			// ECS starts the proxy's tasks with this one: it pulls this namespace's proxy images, writes the proxy's log group
			// and reads the proxy's secrets (the IAM key, the per-application proxy secrets) under the namespace's `env/`.
			ProxyExecutionRole: {
				Type: 'AWS::IAM::Role',
				Properties: {
					RoleName: resources.executionRoleName,
					Path: IAM_PATH,
					PermissionsBoundary: awsAppsPermissionsBoundary(accountId),
					AssumeRolePolicyDocument: trust('ecs-tasks.amazonaws.com', accountId, ecs),
					Policies: [
						policy('execution', [
							allow(['ecr:GetAuthorizationToken'], ['*']),
							allow(['ecr:BatchCheckLayerAvailability', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'], [repositoryArn]),
							allow(['logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${region}:${accountId}:log-group:${resources.logGroup}:*`]),
							allow(['ssm:GetParameters'], [`arn:aws:ssm:${region}:${accountId}:parameter${resources.parameterPath}/env/*`]),
						]),
					],
					Tags: tags,
				},
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
			// A target group's `Ref` is its ARN.
			[PROXY_TARGET_GROUP_OUTPUT]: { Value: { Ref: 'ProxyTargetGroup' } },
		},
	}
	return { stackName: resources.stackName, template, tags: { 'fabrika:namespace': namespace.id, 'fabrika:env': namespace.env } }
}

/** The outputs the namespace's template declares, each of its form. */
export function namespaceOutputsOf(name: string, outputs: Readonly<Record<string, string>>): AwsNamespaceOutputs {
	const proxySecurityGroupId = outputs[PROXY_SECURITY_GROUP_OUTPUT] ?? ''
	const serviceConnectNamespaceArn = outputs[SERVICE_CONNECT_OUTPUT] ?? ''
	const proxyTargetGroupArn = outputs[PROXY_TARGET_GROUP_OUTPUT] ?? ''
	if (
		!SECURITY_GROUP_ID.test(proxySecurityGroupId) || !SERVICE_CONNECT_ARN.test(serviceConnectNamespaceArn)
		|| !TARGET_GROUP_ARN.test(proxyTargetGroupArn)
	) {
		throw new Error(`aws: the stack ${name} names no proxy security group, Service Connect namespace or target group of the form AWS gives one`)
	}
	return { proxySecurityGroupId, serviceConnectNamespaceArn, proxyTargetGroupArn }
}

/**
 * The installation's balancer as a namespace's stack needs it: its security group, which each proxy's group admits on
 * the proxy's public and health ports, and the VPC's IPv4 range, which the proxy's egress to its applications is
 * scoped to. Control's configuration, never a registrant's.
 */
export interface AwsInstallationBalancer {
	readonly securityGroupId: string
	readonly vpcCidr: string
	/** The balancer's HTTPS listener, which serves every namespace's hosts with their certificates (`host-rules.ts`). */
	readonly listenerArn: string
	/**
	 * The installation's own hosts (IAM's, Control's, the console's, the platform proxy's): no namespace's host rule may
	 * take one, whatever the listener's rules say. Lower-case.
	 */
	readonly installationHosts: readonly string[]
}

/** An IPv4 CIDR block of a VPC's size (a /16 to a /28). */
const VPC_CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:1[6-9]|2[0-8])$/

/** Whether `cidr` (of the `VPC_CIDR` form) names its network address: no bit is set past its prefix, as a VPC's block. */
function isNetworkAddress(cidr: string): boolean {
	const [address = '', prefix = ''] = cidr.split('/')
	const value = address.split('.').reduce((sum, octet) => sum * 256 + Number(octet), 0)
	return value % 2 ** (32 - Number(prefix)) === 0
}

/**
 * `balancer` as given, or an error naming the field of another form (never a value). The range is the VPC's primary
 * block as AWS names it; an application in a subnet of a secondary block is not covered by the proxy's egress.
 */
export function checkInstallationBalancer(balancer: AwsInstallationBalancer): AwsInstallationBalancer {
	if (!SECURITY_GROUP_ID.test(balancer.securityGroupId)) throw new Error("aws: the installation's balancer names a security group id of another form")
	if (!VPC_CIDR.test(balancer.vpcCidr) || !isNetworkAddress(balancer.vpcCidr)) {
		throw new Error("aws: the installation's VPC range is not an IPv4 block of a VPC's size named by its network address")
	}
	if (!LISTENER_ARN.test(balancer.listenerArn)) throw new Error("aws: the installation's balancer names a listener of another form")
	const hosts = balancer.installationHosts
	if (hosts.length === 0 || !hosts.every((host) => CERTIFICATE_HOST.test(host)) || new Set(hosts).size !== hosts.length) {
		throw new Error("aws: the installation's own hosts are none, one twice, or one that is not a lower-case host name")
	}
	return balancer
}

/**
 * What the namespace's presentation says of its certificates (`ensureAwsProxyCertificates`): a fact per host, and for a
 * pending one the record the operator adds, then a reconcile; for one that failed, the way out.
 */
export function awsProxyCertificatePresentation(target: AwsNamespaceTarget): {
	readonly facts: readonly ProviderNamespaceFact[]
	readonly instructions: readonly string[]
} {
	const certificates = target.proxyCertificates ?? []
	const instructions: string[] = []
	for (const certificate of certificates) {
		if (certificate.departed === true) {
			instructions.push(
				`The host ${certificate.host} is no member's any more: delete its certificate ${certificate.arn} in Certificate Manager once it is off the listener, and its DNS record; the next reconcile forgets it.`,
			)
		} else if (certificate.listenerConflict === true) {
			// First come keeps a host: a later claim never takes it over, and only the operator knows whose it is.
			instructions.push(
				`The host ${certificate.host} is not served by this namespace: another rule of the installation's listener already routes it (another namespace's, or the installation's own), or it is one of the installation's own hosts. Whoever routed it first keeps it. If it belongs here, remove the domain from the environment that holds it (or the listener's rule that names it), then reconcile this namespace; otherwise remove it from this namespace's member.`,
			)
		} else if (certificate.status === 'PENDING_VALIDATION') {
			instructions.push(
				certificate.validationName === undefined || certificate.validationValue === undefined
					? `The certificate for ${certificate.host} was just requested: reconcile the namespace in a minute to read the DNS record it needs.`
					: `The certificate of ${certificate.host} needs the DNS record ${certificate.validationName} CNAME ${certificate.validationValue}: add it and keep it in place (Certificate Manager renews with it), and reconcile the namespace once it is in place.`,
			)
		} else if (certificate.status !== 'ISSUED') {
			instructions.push(
				`The certificate for ${certificate.host} is ${certificate.status}: delete ${certificate.arn} in Certificate Manager, then reconcile the namespace to request a new one.`,
			)
		}
	}
	if (certificates.length >= AWS_MAX_PROXY_CERTIFICATES) {
		instructions.push(
			`The namespace holds ${AWS_MAX_PROXY_CERTIFICATES} certificates, the listener's quota: a new host gets one only once a departed host's certificate is deleted.`,
		)
	}
	return {
		facts: certificates.flatMap((certificate) => [
			{ label: `Certificate for ${certificate.host}`, value: `${certificate.arn} (${certificate.status})`, resource: true },
			// The record stays in DNS for as long as the certificate lives: renewal validates with it.
			...(certificate.validationName === undefined || certificate.validationValue === undefined
				? []
				: [{ label: `DNS record for ${certificate.host}`, value: `${certificate.validationName} CNAME ${certificate.validationValue}` }]),
		]),
		instructions,
	}
}

/** What the presentation says of a hosts stack the last pass could not apply. */
function hostsFailureInstruction(failure: AwsProxyHostsFailure, hostsStackName: string): string {
	switch (failure) {
		case 'pending':
			return `The stack ${hostsStackName} (this namespace's rules on the installation's listener) was still being applied: reconcile the namespace to follow it.`
		case 'failed':
			return `The stack ${hostsStackName} (this namespace's rules on the installation's listener) could not be applied; its events in CloudFormation say why (a rule priority taken at the same moment, the listener's rule or certificate quota). Reconcile the namespace to try again. The rest of the namespace runs as ever.`
		case 'defaultForwards':
			return `The installation's listener forwards its default action to this namespace, so no host of it is served: the default action must be a fixed answer. Change it, then reconcile the namespace.`
	}
}

/**
 * The hosts the namespace's members are routed on: an approved member's domain. A member the manifest would refuse (no
 * domain) has none here; the republish refuses it with the manifest.
 */
export function awsServedHosts(members: readonly ProviderNamespaceMember[]): readonly string[] {
	const routable = members.filter((member) => member.access !== undefined && member.domain !== undefined && member.domain !== '')
	return [...new Set(routable.flatMap((member) => awsNamespaceMemberHosts(member)))].sort()
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
	readonly balancer: AwsInstallationBalancer
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
		...(stored?.proxyImageDigest === undefined ? {} : { proxyImageDigest: stored.proxyImageDigest }),
		...(stored?.proxyImageManifestSha256 === undefined ? {} : { proxyImageManifestSha256: stored.proxyImageManifestSha256 }),
		...(stored?.proxyServiceTaskDefinitionArn === undefined ? {} : { proxyServiceTaskDefinitionArn: stored.proxyServiceTaskDefinitionArn }),
		...(stored?.proxyServiceFingerprint === undefined ? {} : { proxyServiceFingerprint: stored.proxyServiceFingerprint }),
		...(stored?.proxyServiceUpdated === undefined ? {} : { proxyServiceUpdated: stored.proxyServiceUpdated }),
		...(stored?.proxyServiceRolledOut === undefined ? {} : { proxyServiceRolledOut: stored.proxyServiceRolledOut }),
		...(stored?.proxyCertificates === undefined ? {} : { proxyCertificates: stored.proxyCertificates }),
		...(stored?.proxyHostsFailure === undefined ? {} : { proxyHostsFailure: stored.proxyHostsFailure }),
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
	const { installation, network, balancer, clients, proxySource } = options

	const present = (namespace: ProviderDeploymentNamespace): ProviderNamespacePresentation => {
		const resources = awsNamespaceResources(namespace.id, namespace.env)
		const target = awsNamespaceTargetCodec.decode(namespace.target.payload)
		const certificates = awsProxyCertificatePresentation(target)
		return {
			preset: AWS_CHEAP_PRESET,
			title: `AWS namespace ${namespace.id}`,
			facts: [
				{ label: 'Region', value: installation.region },
				{ label: 'Stack', value: resources.stackName, resource: true },
				{ label: 'Hosts stack', value: resources.hostsStackName, resource: true },
				{ label: 'Service Connect namespace', value: resources.serviceConnectNamespace, resource: true },
				{ label: 'Proxy image repository', value: resources.repository, resource: true },
				{ label: 'Proxy build project', value: resources.buildProject, resource: true },
				{ label: 'Proxy service', value: `${installation.cluster}/${resources.service}`, resource: true },
				// A policy choice, not a resource: the pin the proxy is built from until an operator moves it.
				{ label: 'Proxy source', value: `${target.proxyRepository}@${target.proxyCommitSha}` },
				...certificates.facts,
			],
			instructions: [
				"Control creates the stacks and the proxy's service. Removing the namespace leaves them in place.",
				// The hosts stack's rules forward to the namespace stack's target group, and the service lives outside the stack
				// and holds its security group, roles and log group: deleting the stack first removes the roles under a running
				// service and then fails on the group its network interfaces hold.
				`When no environment uses the namespace, delete in this order: the stack ${resources.hostsStackName}; the ECS service ${resources.service} in the cluster ${installation.cluster}; then the parameters under ${resources.parameterPath}/env and the task definition family ${resources.service}; then the stack ${resources.stackName}.`,
				"Deleting the stack deletes the proxy's images with their repository: they are rebuilt from the namespace's pinned source.",
				...certificates.instructions,
				...(target.proxyHostsFailure === undefined ? [] : [hostsFailureInstruction(target.proxyHostsFailure, resources.hostsStackName)]),
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
			// The namespace's own stack alone: its hosts' rules are a stack of their own (`proxy-hosts.ts`), which nothing
			// here waits on.
			await ensureStack({
				cloudFormation: clients.cloudFormation,
				stack: awsNamespaceStack(input.namespace, installation, network, balancer),
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
			// Control normalizes only what a caller submits (a namespace created or adopted, a plan), never a stored namespace.
			// So the target is the installation's, never a caller's: one of another form or for another account is refused,
			// and so is a pin a caller chose. A new namespace is pinned to the installation's default (ADR-0045); only an
			// operator's update moves a stored pin, and only to the default. The lifecycle calls (`apply`) keep a stored pin.
			const submitted = checkNamespaceTarget(namespace, installation, proxySource)
			if (submitted.proxyCommitSha !== proxySource.commitSha) {
				throw new Error("aws: a namespace is pinned to the installation's proxy commit; another commit is not one a caller chooses")
			}
			if (
				submitted.proxyBuildToken !== undefined || submitted.proxyBuildManifestSha256 !== undefined || submitted.proxyBuildId !== undefined
				|| submitted.proxyImageDigest !== undefined || submitted.proxyImageManifestSha256 !== undefined
				|| submitted.proxyServiceTaskDefinitionArn !== undefined || submitted.proxyServiceFingerprint !== undefined
				|| submitted.proxyServiceUpdated !== undefined || submitted.proxyServiceRolledOut !== undefined
				|| submitted.proxyCertificates !== undefined || submitted.proxyHostsFailure !== undefined
			) {
				throw new Error("aws: a namespace's proxy build, image and certificates are recorded by its provider, never submitted")
			}
			return { ...namespace, target: targetOf(namespace, installation, proxySource) }
		},
		namespaceResourceClaims: (namespace) => {
			const resources = awsNamespaceResources(namespace.id, namespace.env)
			return [`${STACK_CLAIM}${resources.stackName}`, `${STACK_CLAIM}${resources.hostsStackName}`]
		},
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
