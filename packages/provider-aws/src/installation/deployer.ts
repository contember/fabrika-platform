// The deployer: the role the operator's sidecar workflow takes through GitHub's OIDC provider to run
// `fabrika platform upgrade`, with no long-lived key anywhere (the AWS idea's checklist, step 11, the commands' step).
// Decided 2026-11-27: administrator access with safeguards.
//
// - **Why administrator access.** An upgrade applies stacks that create roles and policies, so whoever may run the
//   workflow can do what those templates can, whatever a narrower policy listed: a list of actions would buy brittleness
//   and no safety. The same holds on Zerops, whose workflow holds a project token in a GitHub Environment.
// - **Who may take it.** Only a GitHub Actions job of one repository running in one Environment: the token's `sub` is
//   exactly `repo:<owner>/<name>:environment:<environment>` and its `aud` is `sts.amazonaws.com`. Which branches may use
//   the Environment, and whether a person approves each run (recommended), are GitHub's settings on it (`init`).
// - **The safeguards**, a permissions boundary every one of whose denials holds whatever the role's policies say:
//   - nothing IAM on the deployer's own role, its boundary and GitHub's OIDC provider, and nothing on its stack, so a
//     run can neither widen nor re-trust the deployer;
//   - no IAM user and no long-lived credential (access key, password, service credential, signing certificate, SSH
//     key), and no identity provider made, changed or deleted, so no other way in is left behind;
//   - no role or policy written outside `/fabrika/`, where every one of the platform's is;
//   - no role assumed: the upgrade passes roles to services and never takes one, so a role it made is no way past this;
//   - nothing on the account or its organization (`account:*`, `organizations:*`, the alias, the password policy).
// - **What remains.** A role the deployer makes under `/fabrika/` for a service (a task, a function) carries no
//   boundary, and code that service runs is not held by this one. That is the reach of applying the platform's
//   templates; the GitHub Environment's protection is what guards it.
// - **Out of Control's reach.** The role is under `/fabrika/platform/`, on which Control's role is denied every IAM action,
//   and the stack is a `fabrika-platform-` one, which no grant of Control's names.
//
// The stack is applied by `init` with the operator's credentials; the OIDC provider, which an account holds once for
// every workflow, is ensured beside it (`../aws/iam.ts`).
//
// UNVERIFIED: that GitHub's token for a job in an Environment carries that `sub` (an organization may customize the
// claim), and the session length AWS grants; neither was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { GITHUB_OIDC_AUDIENCE, GITHUB_OIDC_HOST, githubOidcProviderArn, type IamGithubIdentity } from '../aws/iam'
import { type AwsStack, ensureStack, type EnsureStackInput } from '../stack'
import { AWS_PLATFORM_PATH } from './access'
import { AWS_ACCOUNT_ID_FORM } from './runtime'

export const AWS_DEPLOYER_STACK = 'fabrika-platform-deployer'
export const AWS_DEPLOYER_ROLE = 'fabrika-platform-deployer'
export const AWS_DEPLOYER_BOUNDARY = 'fabrika-platform-deployer-boundary'
/** How long a session lasts: the workflow's job, an upgrade with both images built, and a margin. */
export const AWS_DEPLOYER_SESSION_SECONDS = 10_800
/** The administrator access the role holds, inside its boundary. */
export const AWS_ADMINISTRATOR_ACCESS = 'arn:aws:iam::aws:policy/AdministratorAccess'

/** A repository as GitHub names it; an Environment's name as the trust compares it (no wildcard, no `:`). */
const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/
const ENVIRONMENT = /^[A-Za-z0-9._-]{1,64}$/

export interface AwsDeployerInput {
	readonly accountId: string
	/** The sidecar repository, `<owner>/<name>` exactly as GitHub writes it in the token. */
	readonly repository: string
	/** The GitHub Environment its workflow runs in. */
	readonly environment: string
}

/** The role's ARN in `accountId`. */
export function awsDeployerRoleArn(accountId: string): string {
	return `arn:aws:iam::${accountId}:role${AWS_PLATFORM_PATH}${AWS_DEPLOYER_ROLE}`
}

/** The `sub` GitHub's token carries for a job of `repository` running in `environment`. */
export function awsDeployerSubject(input: Pick<AwsDeployerInput, 'repository' | 'environment'>): string {
	return `repo:${input.repository}:environment:${input.environment}`
}

/** Refuses an input of another form before anything is rendered: each lands in a trust condition. */
export function checkAwsDeployerInput(input: AwsDeployerInput): AwsDeployerInput {
	if (!AWS_ACCOUNT_ID_FORM.test(input.accountId)) throw new Error('aws: the account id is not 12 digits')
	if (!REPOSITORY.test(input.repository)) throw new Error('aws: the sidecar repository is not <owner>/<name>')
	if (!ENVIRONMENT.test(input.environment)) throw new Error('aws: the GitHub Environment is not a name of letters, digits, ., _ and -')
	return input
}

const deny = (actions: readonly string[], resources: readonly string[]): JsonValue => ({
	Effect: 'Deny',
	Action: [...actions],
	Resource: [...resources],
})

/** The boundary's statements: everything, but for the denials above. */
export function awsDeployerBoundaryStatements(accountId: string): JsonValue[] {
	const a = accountId
	const own = [awsDeployerRoleArn(a), `arn:aws:iam::${a}:policy${AWS_PLATFORM_PATH}${AWS_DEPLOYER_BOUNDARY}`, githubOidcProviderArn(a)]
	return [
		{ Effect: 'Allow', Action: '*', Resource: '*' },
		deny(['iam:*'], own),
		deny(['cloudformation:*'], [`arn:aws:cloudformation:*:${a}:stack/${AWS_DEPLOYER_STACK}/*`]),
		deny(
			[
				'iam:CreateUser',
				'iam:CreateAccessKey',
				'iam:UpdateAccessKey',
				'iam:CreateLoginProfile',
				'iam:UpdateLoginProfile',
				'iam:CreateServiceSpecificCredential',
				'iam:UpdateServiceSpecificCredential',
				'iam:UploadSigningCertificate',
				'iam:UploadSSHPublicKey',
			],
			['*'],
		),
		deny(
			[
				'iam:CreateOpenIDConnectProvider',
				'iam:DeleteOpenIDConnectProvider',
				'iam:UpdateOpenIDConnectProviderThumbprint',
				'iam:AddClientIDToOpenIDConnectProvider',
				'iam:RemoveClientIDFromOpenIDConnectProvider',
				'iam:CreateSAMLProvider',
				'iam:UpdateSAMLProvider',
				'iam:DeleteSAMLProvider',
			],
			['*'],
		),
		{
			Effect: 'Deny',
			Action: [
				'iam:CreateRole',
				'iam:UpdateAssumeRolePolicy',
				'iam:PutRolePolicy',
				'iam:AttachRolePolicy',
				'iam:PutRolePermissionsBoundary',
				'iam:DeleteRolePermissionsBoundary',
			],
			NotResource: [`arn:aws:iam::${a}:role/fabrika/*`],
		},
		{
			Effect: 'Deny',
			Action: ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion'],
			NotResource: [`arn:aws:iam::${a}:policy/fabrika/*`],
		},
		deny(['sts:AssumeRole'], ['*']),
		deny(
			[
				'account:*',
				'organizations:*',
				'iam:CreateAccountAlias',
				'iam:DeleteAccountAlias',
				'iam:UpdateAccountPasswordPolicy',
				'iam:DeleteAccountPasswordPolicy',
			],
			['*'],
		),
	]
}

/** The deployer's stack: its boundary and its role. */
export function awsDeployerStack(input: AwsDeployerInput): AwsStack {
	const { accountId } = checkAwsDeployerInput(input)
	return {
		stackName: AWS_DEPLOYER_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: 'fabrika: the role the sidecar workflow takes to upgrade the installation, inside its boundary',
			Resources: {
				DeployerBoundary: {
					Type: 'AWS::IAM::ManagedPolicy',
					Properties: {
						ManagedPolicyName: AWS_DEPLOYER_BOUNDARY,
						Path: AWS_PLATFORM_PATH,
						Description: "fabrika: the ceiling of the sidecar workflow's role",
						PolicyDocument: { Version: '2012-10-17', Statement: awsDeployerBoundaryStatements(accountId) },
					},
				},
				DeployerRole: {
					Type: 'AWS::IAM::Role',
					Properties: {
						RoleName: AWS_DEPLOYER_ROLE,
						Path: AWS_PLATFORM_PATH,
						Description: `fabrika: taken by ${input.repository}'s workflow in its ${input.environment} Environment`,
						MaxSessionDuration: AWS_DEPLOYER_SESSION_SECONDS,
						PermissionsBoundary: { Ref: 'DeployerBoundary' },
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
 * workflow names. The stack's answer is compared with the ARN the role must have, so a workflow is never pointed at
 * another role.
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
	log(`aws: the deployer role ${arn} trusts ${awsDeployerSubject(input)} alone`)
	return arn
}
