// The AWS installation's composition: Control's process on ECS signs every AWS call with its task role's credentials
// from the container endpoint, and reads an application's repository through the unbound GitHub source, because the
// AWS provider renders the build from the contract and binds no root file. No installation runs this yet: the
// installation's stack (checklist step 11 of docs/ideas/aws-provider.md) is not built.
//
// Variables:
// - `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`: set by ECS in every task with a task role.
// - `FABRIKA_AWS_BASE_IMAGE`: the Bun image an application's build starts from, pinned by digest.
// - `FABRIKA_AWS_ACCOUNT_ID`, `FABRIKA_AWS_REGION`, `FABRIKA_AWS_CLUSTER`, `FABRIKA_AWS_SOURCES_BUCKET`: the
//   installation's coordinates, every environment's target. They are Control's configuration, never a registrant's,
//   because each aims Control's signed calls. Each environment builds in its own project (`awsEnvironmentStack`).
// - `FABRIKA_AWS_VPC_ID`, `FABRIKA_AWS_SUBNETS` (comma-separated subnet ids) and `FABRIKA_AWS_TASK_PUBLIC_IP` (`true`
//   or `false`): the installation's network. Each environment's security group is created in the VPC, and its service
//   and init tasks run in the subnets, with a public address only when the variable says `true` (public subnets with
//   no NAT gateway); there is no default, because a wrong one leaves the tasks without a way out.
// - `FABRIKA_AWS_BALANCER_SECURITY_GROUP` (a security group id) and `FABRIKA_AWS_VPC_CIDR` (the VPC's IPv4 block): the
//   installation balancer's group, which each namespace proxy's group admits on its public and health ports, and the
//   range a proxy's egress to its applications is scoped to: the VPC's primary block, by its network address. An
//   application in a subnet of a secondary block is not reachable from its proxy.
// - `FABRIKA_AWS_BALANCER_LISTENER`: the balancer's HTTPS listener (an ARN), on which every namespace's stack serves its
//   hosts: a certificate and a host rule each, forwarding to the namespace's proxy. Its default action is a fixed answer.
// - `FABRIKA_AWS_INSTALLATION_HOSTS` (comma-separated): the installation's own hosts (IAM's, Control's, the console's,
//   the platform proxy's), which no namespace's host rule may take.
// - `FABRIKA_AWS_BALANCER_SUBNET_CIDRS` (comma-separated IPv4 blocks inside the VPC's): the balancer's own subnets, the
//   only addresses a namespace proxy trusts `X-Forwarded-For` from. No task may run in them: a trusted range that held a
//   task would let it choose the client address its requests are seen from (`AwsInstallationBalancer`).
// - `FABRIKA_AWS_PROXY_REPOSITORY` (an HTTPS GitHub URL) and `FABRIKA_AWS_PROXY_COMMIT_SHA` (a full commit): the
//   installation's release of the public platform repository. A namespace being planned is pinned to it, and keeps
//   its pin through an upgrade; no namespace may be pinned to another repository (ADR-0045).
// - `FABRIKA_AWS_PROXY_IAM_URL` and `FABRIKA_AWS_PROXY_IAM_KEY`: the IAM every namespace proxy asks, and the key IAM knows
//   as the proxies'. The key is a credential: it reaches each proxy through Parameter Store alone.

import { containerCredentials } from '@fabrika/platform-node'
import { type AwsSourcePort, awsSourceRepository, createAwsControlProvider } from '@fabrika/provider-aws'
import type { ControlProvider } from '@fabrika/provider-contract'
import type { BunProviderComposition, GitHubSourceSeams } from '../bun/runtime'
import type { Env } from '../env'
import { gitHubAppClientFactory, vaultGitHubCredentials } from '../github/connections/credentials'
import { createUnboundGitHubSource } from '../github/source'
import type { CommitSource } from '../github/source/commit-files'
import { AWS_MAIL_REMEDY } from '../mail-transport'

const required = (source: Record<string, string | undefined>, name: string): string => {
	const value = source[name]
	if (value === undefined || value.trim() === '') throw new Error(`${name} is required by the AWS provider`)
	return value
}

/** A variable that must say `true` or `false`. */
const flag = (source: Record<string, string | undefined>, name: string): boolean => {
	const value = required(source, name).trim()
	if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`)
	return value === 'true'
}

/**
 * Control's in-process source over the vault's GitHub keys. A source upload goes to the provider's S3 part writer
 * only, so no URL is a destination.
 */
export function awsGitHubSources(env: Env, seams: GitHubSourceSeams = {}): { readonly port: AwsSourcePort; readonly commits: CommitSource } {
	const source = createUnboundGitHubSource({
		credentials: vaultGitHubCredentials(env, { createClient: gitHubAppClientFactory(seams.githubAppFetch) }),
		isUploadDestination: () => false,
		...(seams.metadataFetch === undefined ? {} : { metadataFetch: seams.metadataFetch }),
		...(seams.downloadFetch === undefined ? {} : { downloadFetch: seams.downloadFetch }),
	})
	return { port: { resolve: (input) => source.resolve(input), upload: (input) => source.upload(input) }, commits: source.commits }
}

/** Compose the only provider available in the AWS installation's process. */
export function awsControlProvider(source: Record<string, string | undefined>, sourcePort: AwsSourcePort): ControlProvider {
	const relativeUri = required(source, 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI')
	return createAwsControlProvider({
		credentials: containerCredentials(relativeUri),
		// A fresh read of the endpoint per run: the held set is refreshed only shortly before it expires, and the build's
		// presigned read must outlive its URL.
		presignCredentials: () => containerCredentials(relativeUri),
		baseImage: required(source, 'FABRIKA_AWS_BASE_IMAGE'),
		installation: {
			accountId: required(source, 'FABRIKA_AWS_ACCOUNT_ID'),
			region: required(source, 'FABRIKA_AWS_REGION'),
			cluster: required(source, 'FABRIKA_AWS_CLUSTER'),
			sourcesBucket: required(source, 'FABRIKA_AWS_SOURCES_BUCKET'),
		},
		network: {
			vpcId: required(source, 'FABRIKA_AWS_VPC_ID'),
			subnets: required(source, 'FABRIKA_AWS_SUBNETS').split(',').map((subnet) => subnet.trim()),
			publicIp: flag(source, 'FABRIKA_AWS_TASK_PUBLIC_IP'),
		},
		balancer: {
			securityGroupId: required(source, 'FABRIKA_AWS_BALANCER_SECURITY_GROUP').trim(),
			vpcCidr: required(source, 'FABRIKA_AWS_VPC_CIDR').trim(),
			listenerArn: required(source, 'FABRIKA_AWS_BALANCER_LISTENER').trim(),
			installationHosts: required(source, 'FABRIKA_AWS_INSTALLATION_HOSTS').split(',').map((host) => host.trim().toLowerCase()),
			balancerSubnetCidrs: required(source, 'FABRIKA_AWS_BALANCER_SUBNET_CIDRS').split(',').map((cidr) => cidr.trim()),
		},
		// The installation's release of the public platform repository: a planned namespace's proxy pin (ADR-0045).
		proxySource: {
			repository: awsSourceRepository(required(source, 'FABRIKA_AWS_PROXY_REPOSITORY')),
			commitSha: required(source, 'FABRIKA_AWS_PROXY_COMMIT_SHA').trim(),
		},
		// The IAM every namespace proxy asks, and the key IAM knows as the proxies' (its `FABRIKA_IAM_PROXY_KEY`).
		proxyIam: {
			issuer: required(source, 'FABRIKA_AWS_PROXY_IAM_URL'),
			key: required(source, 'FABRIKA_AWS_PROXY_IAM_KEY'),
		},
		source: sourcePort,
	})
}

/** The AWS installation's provider, over the in-process GitHub source, for the Bun host. */
export const awsComposition: BunProviderComposition = {
	mailRemedy: AWS_MAIL_REMEDY,
	compose: (env, source, seams) => {
		const github = awsGitHubSources(env, seams)
		return { provider: awsControlProvider(source, github.port), commits: github.commits }
	},
}
