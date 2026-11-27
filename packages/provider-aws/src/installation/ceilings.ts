// The installation's two ceilings, in one stack only the operator's own credentials change (the AWS idea's checklist,
// step 11; decided 2026-11-27 with the deployer, "administrator access with safeguards", the safeguards to hold):
//
// - **The platform's ceiling** (`fabrika-platform-boundary`, P): the permissions boundary of every platform role
//   (Control's, the certificate broker's, the task runner's, the images build's, each task's execution role,
//   Operations' task role) and of the deployer, the role the sidecar workflow takes (`deployer.ts`).
// - **The applications' ceiling** (`fabrika-apps-boundary`, A): the boundary of every role Control's stacks create
//   (`access.ts`'s `awsAppsBoundaryStatements`). It moved here from the access stack, which an upgrade applies: under
//   the deployer, a ceiling an upgrade could rewrite would be no ceiling.
//
// P allows everything but what follows, so it holds whatever a role's own policies say, and it propagates: a role a
// P-bound role writes must itself carry P or A.
//
// - **Roles carry a ceiling.** Creating a role, writing or removing its policies, or setting its boundary only where
//   `iam:PermissionsBoundary` is P or A, and only under `/fabrika/`; removing a boundary nowhere. Re-trusting, tagging or
//   untagging a role only under `/fabrika/` (IAM evaluates no boundary key for those).
// - **The ceilings, the deployer and GitHub's provider are out of reach.** No new version or deletion of P or A; no
//   policy made, versioned, set back to an older version or deleted outside `/fabrika/`; no IAM action on the deployer's role or GitHub's OIDC provider; nothing but
//   reads on the ceilings' and the deployer's stacks.
// - **No other way in.** No IAM user, group or long-lived credential (access keys, passwords, service credentials,
//   signing certificates, SSH keys, an MFA device turned off); no identity provider made, changed or deleted (OIDC,
//   SAML, IAM Roles Anywhere, IAM Identity Center and its identity store, Cognito identity pools).
// - **Roles passed to the installation's services alone.** `iam:PassRole` only on a role under `/fabrika/`, and only to
//   ECS tasks, CodeBuild or Lambda: never to CloudFormation as a stack's service role, nor to EC2 or another service.
// - **No role assumed.** No platform role and no upgrade assumes one, so a role made under P is no way past it.
// - **Not the account.** Nothing on the account or its organization, its alias or its password policy.
//
// What no IAM condition holds, the remaining reach, stated in the operator's guide with the GitHub Environment's
// protection and a dedicated account:
//
// - **A trust pointing outside.** A role under `/fabrika/` may be created or re-trusted to anyone (no condition key
//   reads a trust policy). Whoever then takes it gets P, never more.
// - **Another workload's code.** In an account shared with other workloads, P does not keep the deployer from running
//   code under their existing roles (updating a function's code, a build project, a command on an instance). The
//   installation's account should hold nothing else.
// - **A role made by hand.** A role someone else creates under `/fabrika/` without a ceiling, re-trusted and passed, is
//   past P. Nothing in the installation makes one.
//
// UNVERIFIED: that IAM evaluates `iam:PermissionsBoundary` on each role write named here, `iam:PassedToService` on
// every pass a stack makes, and the actions each service's handlers call; the live check (step 13) settles them.

import type { JsonValue } from '@fabrika/provider-contract'
import { githubOidcProviderArn } from '../aws/iam'
import { awsAppsPermissionsBoundary } from '../environment-stack'
import type { AwsStack } from '../stack'
import { AWS_PLATFORM_BOUNDARY, AWS_PLATFORM_PATH, awsAppsBoundaryStatements, awsPlatformBoundaryArn } from './access'
import { AWS_ACCOUNT_ID_FORM, AWS_REGION_FORM } from './runtime'

export const AWS_CEILINGS_STACK = 'fabrika-platform-ceilings'
/** The deployer's stack and role (`deployer.ts`), named here so the ceiling keeps them out of reach. */
export const AWS_DEPLOYER_STACK = 'fabrika-platform-deployer'
export const AWS_DEPLOYER_ROLE = 'fabrika-platform-deployer'
/** The services the installation passes roles to: ECS tasks, its builds, its two functions. */
export const AWS_PASSED_TO_SERVICES: readonly string[] = ['ecs-tasks.amazonaws.com', 'codebuild.amazonaws.com', 'lambda.amazonaws.com']

/** The deployer's role ARN in `accountId`. */
export function awsDeployerRoleArn(accountId: string): string {
	return `arn:aws:iam::${accountId}:role${AWS_PLATFORM_PATH}${AWS_DEPLOYER_ROLE}`
}

const deny = (actions: readonly string[], resources: readonly string[], condition?: JsonValue): JsonValue => ({
	Effect: 'Deny',
	Action: [...actions],
	Resource: [...resources],
	...(condition === undefined ? {} : { Condition: condition }),
})

/** The platform's ceiling: everything, but for the denials above. */
export function awsPlatformBoundaryStatements(accountId: string): JsonValue[] {
	const a = accountId
	const ceilings = [awsPlatformBoundaryArn(a), awsAppsPermissionsBoundary(a)]
	const fabrikaRoles = `arn:aws:iam::${a}:role/fabrika/*`
	const stacks = [AWS_CEILINGS_STACK, AWS_DEPLOYER_STACK].map((name) => `arn:aws:cloudformation:*:${a}:stack/${name}/*`)
	return [
		{ Effect: 'Allow', Action: '*', Resource: '*' },
		deny(
			['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:DeleteRolePolicy', 'iam:PutRolePermissionsBoundary'],
			['*'],
			{ StringNotEquals: { 'iam:PermissionsBoundary': ceilings } },
		),
		deny(['iam:DeleteRolePermissionsBoundary'], ['*']),
		// Outside `/fabrika/`, no role is written at all, ceiling or not; re-trusting and tagging take no boundary key.
		{
			Effect: 'Deny',
			Action: [
				'iam:CreateRole',
				'iam:PutRolePolicy',
				'iam:AttachRolePolicy',
				'iam:DetachRolePolicy',
				'iam:DeleteRolePolicy',
				'iam:PutRolePermissionsBoundary',
				'iam:UpdateAssumeRolePolicy',
				'iam:TagRole',
				'iam:UntagRole',
			],
			NotResource: [fabrikaRoles],
		},
		deny(['iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicy'], ceilings),
		// Outside `/fabrika/`, no policy is made, given a version, or set back to an older one.
		{
			Effect: 'Deny',
			Action: ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicyVersion', 'iam:DeletePolicy'],
			NotResource: [`arn:aws:iam::${a}:policy/fabrika/*`],
		},
		deny(['iam:*'], [awsDeployerRoleArn(a), githubOidcProviderArn(a)]),
		{ Effect: 'Deny', NotAction: ['cloudformation:Describe*', 'cloudformation:Get*', 'cloudformation:List*'], Resource: stacks },
		deny(
			[
				'iam:CreateUser',
				'iam:CreateGroup',
				'iam:AddUserToGroup',
				'iam:AttachUserPolicy',
				'iam:PutUserPolicy',
				'iam:AttachGroupPolicy',
				'iam:PutGroupPolicy',
				'iam:PutUserPermissionsBoundary',
				'iam:DeleteUserPermissionsBoundary',
				'iam:CreateAccessKey',
				'iam:UpdateAccessKey',
				'iam:CreateLoginProfile',
				'iam:UpdateLoginProfile',
				'iam:CreateServiceSpecificCredential',
				'iam:UpdateServiceSpecificCredential',
				'iam:ResetServiceSpecificCredential',
				'iam:UploadSigningCertificate',
				'iam:UploadSSHPublicKey',
				'iam:DeactivateMFADevice',
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
				'rolesanywhere:*',
				'sso:*',
				'sso-directory:*',
				'identitystore:*',
				'cognito-identity:*',
			],
			['*'],
		),
		{ Effect: 'Deny', Action: ['iam:PassRole'], NotResource: [fabrikaRoles] },
		deny(['iam:PassRole'], ['*'], { StringNotEquals: { 'iam:PassedToService': [...AWS_PASSED_TO_SERVICES] } }),
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

/** The ceilings stack: the platform's ceiling and the applications', each a managed policy at the ARN every role names. */
export function awsCeilingsStack(installation: { readonly accountId: string; readonly region: string }): AwsStack {
	const { accountId, region } = installation
	if (!AWS_ACCOUNT_ID_FORM.test(accountId) || !AWS_REGION_FORM.test(region)) throw new Error('aws: the ceilings take an account id and a region name')
	return {
		stackName: AWS_CEILINGS_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the installation's ceilings, changed with the operator's own credentials alone",
			Resources: {
				PlatformBoundary: {
					Type: 'AWS::IAM::ManagedPolicy',
					Properties: {
						ManagedPolicyName: AWS_PLATFORM_BOUNDARY,
						Path: AWS_PLATFORM_PATH,
						Description: "fabrika: the ceiling of every platform role and of the sidecar workflow's",
						PolicyDocument: { Version: '2012-10-17', Statement: awsPlatformBoundaryStatements(accountId) },
					},
				},
				AppsBoundary: {
					Type: 'AWS::IAM::ManagedPolicy',
					Properties: {
						ManagedPolicyName: 'fabrika-apps-boundary',
						Path: '/fabrika/',
						Description: "fabrika: the ceiling of every role Control's stacks create",
						PolicyDocument: { Version: '2012-10-17', Statement: [...awsAppsBoundaryStatements(installation)] },
					},
				},
			},
		},
		tags: { 'fabrika:platform': 'ceilings' },
	}
}
