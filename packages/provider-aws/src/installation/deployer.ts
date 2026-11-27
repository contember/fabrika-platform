// The deployer: the role the operator's sidecar workflow takes through GitHub's OIDC provider to run
// `fabrika platform upgrade`, with no long-lived key anywhere (the AWS idea's checklist, step 11, the commands' step).
// Decided 2026-11-27: administrator access with safeguards, and the safeguards hold.
//
// - **Why administrator access.** An upgrade applies stacks that create roles and policies, so a list of actions would
//   buy brittleness and no safety. What holds is the platform's ceiling (`ceilings.ts`), the deployer's permissions
//   boundary, which every role it writes must carry too (or the applications' ceiling): it can neither widen nor
//   re-trust itself, nor make a user, a long-lived credential or an identity provider, nor pass a role to anything but
//   the installation's services, nor assume one. The ceilings themselves are in a stack it may only read.
// - **Who may take it.** Only a GitHub Actions job of one repository running in one Environment, compared by GitHub's
//   numeric ids, which a renamed or deleted repository's name taken by someone else does not carry: the token's `sub`
//   is exactly `repository_owner_id:<id>:repository_id:<id>:environment:<name>` (the repository's OIDC claim
//   customization, which `init` sets) and its `aud` is `sts.amazonaws.com`. Which branches may use the Environment, and
//   a person approving each run (recommended), are GitHub's settings on it.
// - **What remains** is the ceiling's remaining reach (`ceilings.ts`): a role under `/fabrika/` trusted outside, which
//   gets the ceiling and no more, and, in an account shared with other workloads, their code. The guide says so.
// - **Out of Control's reach.** The role is under `/fabrika/platform/`, on which Control's role is denied every IAM
//   action, and the stack is a `fabrika-platform-` one, which no grant of Control's names.
//
// The stack is applied by `init` with the operator's credentials; the OIDC provider, which an account holds once for
// every workflow, is ensured beside it (`../aws/iam.ts`).
//
// UNVERIFIED: the customized `sub`'s exact form for a job in an Environment, and the session length AWS grants; neither
// was checked against an account.

import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_HOST, githubOidcProviderArn, type IamGithubIdentity } from '../aws/iam'
import { type AwsStack, ensureStack, type EnsureStackInput } from '../stack'
import { AWS_PLATFORM_PATH, awsPlatformBoundaryArn } from './access'
import { AWS_DEPLOYER_ROLE, AWS_DEPLOYER_STACK, awsDeployerRoleArn } from './ceilings'
import { AWS_ACCOUNT_ID_FORM } from './runtime'

export { AWS_DEPLOYER_ROLE, AWS_DEPLOYER_STACK, awsDeployerRoleArn } from './ceilings'

/** How long a session lasts: the workflow's job, an upgrade with both images built, and a margin. */
export const AWS_DEPLOYER_SESSION_SECONDS = 10_800
/** The administrator access the role holds, inside the platform's ceiling. */
export const AWS_ADMINISTRATOR_ACCESS = 'arn:aws:iam::aws:policy/AdministratorAccess'
/** The claims the repository's `sub` is customized to, in order (`init` sets them). */
export const AWS_DEPLOYER_SUBJECT_CLAIMS: readonly string[] = ['repository_owner_id', 'repository_id', 'context']

/** A repository as GitHub names it; GitHub's numeric ids; an Environment's name as the trust compares it. */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const GITHUB_ID = /^[1-9]\d{0,19}$/
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,64}$/

export interface AwsDeployerInput {
	readonly accountId: string
	/** The sidecar repository, `<owner>/<name>`, for the role's description alone. */
	readonly repository: string
	/** GitHub's ids of the repository's owner and of the repository, which the trust compares. */
	readonly repositoryOwnerId: string
	readonly repositoryId: string
	/** The GitHub Environment its workflow runs in. */
	readonly environment: string
}

/** The `sub` GitHub's token carries for a job of the repository running in the Environment, once customized. */
export function awsDeployerSubject(input: Pick<AwsDeployerInput, 'repositoryOwnerId' | 'repositoryId' | 'environment'>): string {
	return `repository_owner_id:${input.repositoryOwnerId}:repository_id:${input.repositoryId}:environment:${input.environment}`
}

/** Refuses an input of another form before anything is rendered: each lands in a trust condition or a description. */
export function checkAwsDeployerInput(input: AwsDeployerInput): AwsDeployerInput {
	if (!AWS_ACCOUNT_ID_FORM.test(input.accountId)) throw new Error('aws: the account id is not 12 digits')
	if (!REPOSITORY.test(input.repository)) throw new Error('aws: the sidecar repository is not <owner>/<name>')
	if (!GITHUB_ID.test(input.repositoryOwnerId) || !GITHUB_ID.test(input.repositoryId)) throw new Error("aws: GitHub's ids are not numbers")
	if (!ENVIRONMENT.test(input.environment)) throw new Error('aws: the GitHub Environment is not a name of letters, digits, ., _ and -')
	return input
}

/** The deployer's stack: its role, inside the platform's ceiling. */
export function awsDeployerStack(input: AwsDeployerInput): AwsStack {
	const { accountId } = checkAwsDeployerInput(input)
	return {
		stackName: AWS_DEPLOYER_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: 'fabrika: the role the sidecar workflow takes to upgrade the installation, inside the platform ceiling',
			Resources: {
				DeployerRole: {
					Type: 'AWS::IAM::Role',
					Properties: {
						RoleName: AWS_DEPLOYER_ROLE,
						Path: AWS_PLATFORM_PATH,
						Description: `fabrika: taken by ${input.repository}'s workflow in its ${input.environment} Environment`,
						MaxSessionDuration: AWS_DEPLOYER_SESSION_SECONDS,
						PermissionsBoundary: awsPlatformBoundaryArn(accountId),
						ManagedPolicyArns: [AWS_ADMINISTRATOR_ACCESS],
						AssumeRolePolicyDocument: {
							Version: '2012-10-17',
							Statement: [{
								Effect: 'Allow',
								Principal: { Federated: githubOidcProviderArn(accountId) },
								Action: 'sts:AssumeRoleWithWebIdentity',
								Condition: {
									StringEquals: {
										[`${GITHUB_OIDC_HOST}:aud`]: GITHUB_OIDC_AUDIENCE,
										[`${GITHUB_OIDC_HOST}:sub`]: awsDeployerSubject(input),
									},
								},
							}],
						},
						Tags: [{ Key: 'fabrika:platform', Value: 'deployer' }],
					},
				},
			},
			Outputs: { RoleArn: { Value: { 'Fn::GetAtt': ['DeployerRole', 'Arn'] } } },
		},
		tags: { 'fabrika:platform': 'deployer' },
	}
}

/** What applying the deployer takes: its input, IAM for GitHub's provider, and CloudFormation for its stack. */
export interface AwsDeployerApply extends Pick<EnsureStackInput, 'cloudFormation' | 'signal' | 'sleep' | 'log'> {
	readonly input: AwsDeployerInput
	readonly iam: IamGithubIdentity
}

/**
 * Ensures GitHub's OIDC provider, then applies the deployer's stack; answers the role's ARN, which the sidecar's
 * workflow names. The ceilings stack must already hold the platform's ceiling (an install applies it first). The stack's
 * answer is compared with the ARN the role must have, so a workflow is never pointed at another role.
 */
export async function applyAwsDeployer(run: AwsDeployerApply): Promise<string> {
	const input = checkAwsDeployerInput(run.input)
	const { signal, log } = run
	const provider = await run.iam.ensureGithubOidcProvider(input.accountId, signal)
	log(
		provider === 'created'
			? `aws: created the account's OIDC provider for GitHub Actions (${GITHUB_OIDC_HOST})`
			: `aws: the account's OIDC provider for GitHub Actions (${GITHUB_OIDC_HOST}) exists`,
	)
	const outputs = await ensureStack({ cloudFormation: run.cloudFormation, stack: awsDeployerStack(input), signal, sleep: run.sleep, log })
	const arn = awsDeployerRoleArn(input.accountId)
	if (outputs['RoleArn'] !== arn) throw new Error(`aws: the ${AWS_DEPLOYER_STACK} stack answers ${outputs['RoleArn'] ?? 'no role'}, not ${arn}`)
	log(`aws: the deployer role ${arn} trusts ${input.repository}'s workflow in its ${input.environment} Environment alone`)
	return arn
}
