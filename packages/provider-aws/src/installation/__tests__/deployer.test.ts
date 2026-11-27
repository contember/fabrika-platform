// The deployer: a role only one repository's workflow in one GitHub Environment may take, with administrator access
// inside a boundary whose denials hold on its own role, provider and stack, on users and long-lived credentials, on
// identity providers, on roles and policies outside `/fabrika/`, on assuming a role and on the account. The boundary is
// read by a small evaluator of explicit denials, so each test states what is refused and what an upgrade still does.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { StackStatus } from '../../aws/cloudformation'
import type { IamGithubIdentity } from '../../aws/iam'
import {
	applyAwsDeployer,
	AWS_ADMINISTRATOR_ACCESS,
	AWS_DEPLOYER_SESSION_SECONDS,
	AWS_DEPLOYER_STACK,
	awsDeployerBoundaryStatements,
	awsDeployerRoleArn,
	awsDeployerStack,
} from '../deployer'

const A = '123456789012'
const INPUT = { accountId: A, repository: 'acme/fabrika-aws-production', environment: 'production' }
const PROVIDER = `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`

interface Statement {
	readonly Effect: string
	readonly Action: string | readonly string[]
	readonly Resource?: string | readonly string[]
	readonly NotResource?: readonly string[]
}

const listOf = (
	value: string | readonly string[] | undefined,
): readonly string[] => (value === undefined ? [] : typeof value === 'string' ? [value] : value)
const glob = (pattern: string, value: string): boolean =>
	new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(value)

/** Whether the boundary refuses `action` on `resource` by an explicit denial. */
function denied(action: string, resource: string): boolean {
	const statements: Statement[] = JSON.parse(JSON.stringify(awsDeployerBoundaryStatements(A)))
	return statements.some((statement) => {
		if (statement.Effect !== 'Deny' || !listOf(statement.Action).some((pattern) => glob(pattern, action))) return false
		if (statement.NotResource !== undefined) return !statement.NotResource.some((pattern) => glob(pattern, resource))
		return listOf(statement.Resource).some((pattern) => glob(pattern, resource))
	})
}

/** The stack's resources, read as plain JSON. */
function resources(): Record<string, { Type: string; Properties: Record<string, JsonValue> }> {
	return JSON.parse(JSON.stringify(awsDeployerStack(INPUT).template)).Resources
}

describe('the deployer', () => {
	test("one repository's workflow in one Environment alone takes the role, through GitHub's provider", () => {
		const role = resources()['DeployerRole']
		expect(role?.Properties['AssumeRolePolicyDocument']).toEqual({
			Version: '2012-10-17',
			Statement: [{
				Effect: 'Allow',
				Principal: { Federated: PROVIDER },
				Action: 'sts:AssumeRoleWithWebIdentity',
				Condition: {
					StringEquals: {
						'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
						'token.actions.githubusercontent.com:sub': 'repo:acme/fabrika-aws-production:environment:production',
					},
				},
			}],
		})
	})

	test('administrator access inside its own boundary, under the platform path Control is denied', () => {
		const { DeployerRole, DeployerBoundary } = resources()
		expect(DeployerRole?.Properties).toMatchObject({
			RoleName: 'fabrika-platform-deployer',
			Path: '/fabrika/platform/',
			ManagedPolicyArns: [AWS_ADMINISTRATOR_ACCESS],
			PermissionsBoundary: { Ref: 'DeployerBoundary' },
			MaxSessionDuration: AWS_DEPLOYER_SESSION_SECONDS,
		})
		expect(DeployerBoundary?.Properties).toMatchObject({ ManagedPolicyName: 'fabrika-platform-deployer-boundary', Path: '/fabrika/platform/' })
		expect(Object.keys(resources()).sort()).toEqual(['DeployerBoundary', 'DeployerRole'])
		expect(awsDeployerRoleArn(A)).toBe(`arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-deployer`)
	})

	test('the boundary: the deployer can neither widen nor re-trust itself, nor leave another way in', () => {
		const role = awsDeployerRoleArn(A)
		const boundary = `arn:aws:iam::${A}:policy/fabrika/platform/fabrika-platform-deployer-boundary`
		for (
			const action of ['iam:UpdateAssumeRolePolicy', 'iam:AttachRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePermissionsBoundary', 'iam:DeleteRole']
		) {
			expect({ action, denied: denied(action, role) }).toEqual({ action, denied: true })
		}
		expect(denied('iam:CreatePolicyVersion', boundary)).toBe(true)
		expect(denied('iam:AddClientIDToOpenIDConnectProvider', PROVIDER)).toBe(true)
		expect(denied('cloudformation:UpdateStack', `arn:aws:cloudformation:eu-central-1:${A}:stack/${AWS_DEPLOYER_STACK}/1`)).toBe(true)
		expect(denied('cloudformation:DeleteStack', `arn:aws:cloudformation:us-east-1:${A}:stack/${AWS_DEPLOYER_STACK}/1`)).toBe(true)
		for (
			const action of [
				'iam:CreateUser',
				'iam:CreateAccessKey',
				'iam:CreateLoginProfile',
				'iam:CreateServiceSpecificCredential',
				'iam:UploadSSHPublicKey',
			]
		) {
			expect({ action, denied: denied(action, `arn:aws:iam::${A}:user/someone`) }).toEqual({ action, denied: true })
		}
		expect(denied('iam:CreateOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/example.com`)).toBe(true)
		expect(denied('iam:CreateSAMLProvider', `arn:aws:iam::${A}:saml-provider/corp`)).toBe(true)
		// A role or policy outside `/fabrika/`, and assuming any role: no way past the boundary through one it made.
		expect(denied('iam:CreateRole', `arn:aws:iam::${A}:role/backdoor`)).toBe(true)
		expect(denied('iam:AttachRolePolicy', `arn:aws:iam::${A}:role/OrganizationAccountAccessRole`)).toBe(true)
		expect(denied('iam:CreatePolicy', `arn:aws:iam::${A}:policy/admin`)).toBe(true)
		expect(denied('sts:AssumeRole', `arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-control`)).toBe(true)
		for (const action of ['organizations:LeaveOrganization', 'account:CloseAccount', 'iam:CreateAccountAlias', 'iam:UpdateAccountPasswordPolicy']) {
			expect({ action, denied: denied(action, '*') }).toEqual({ action, denied: true })
		}
	})

	test("the boundary leaves what an upgrade does: the platform's stacks, roles and policies, images, tasks and parameters", () => {
		expect(denied('cloudformation:UpdateStack', `arn:aws:cloudformation:eu-central-1:${A}:stack/fabrika-platform-services/1`)).toBe(false)
		expect(denied('iam:CreateRole', `arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-control`)).toBe(false)
		expect(denied('iam:PutRolePolicy', `arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-iam-task`)).toBe(false)
		expect(denied('iam:CreatePolicyVersion', `arn:aws:iam::${A}:policy/fabrika/fabrika-apps-boundary`)).toBe(false)
		expect(denied('iam:PassRole', `arn:aws:iam::${A}:role/fabrika/platform/fabrika-platform-control`)).toBe(false)
		expect(denied('iam:CreateServiceLinkedRole', `arn:aws:iam::${A}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`)).toBe(false)
		expect(denied('iam:GetOpenIDConnectProvider', `arn:aws:iam::${A}:oidc-provider/example.com`)).toBe(false)
		for (
			const action of [
				'codebuild:StartBuild',
				'ecs:RunTask',
				'ssm:PutParameter',
				'ecr:DescribeImages',
				'acm:DescribeCertificate',
				'sts:GetCallerIdentity',
			]
		) {
			expect({ action, denied: denied(action, '*') }).toEqual({ action, denied: false })
		}
	})

	test('an input of another form is refused before anything is rendered: each lands in a trust condition', () => {
		expect(() => awsDeployerStack({ ...INPUT, repository: 'acme/*' })).toThrow('not <owner>/<name>')
		expect(() => awsDeployerStack({ ...INPUT, repository: 'acme' })).toThrow('not <owner>/<name>')
		for (const environment of ['prod*', 'prod:ref:refs/heads/main', '', 'a b']) {
			expect(() => awsDeployerStack({ ...INPUT, environment })).toThrow('GitHub Environment')
		}
		expect(() => awsDeployerStack({ ...INPUT, accountId: '1234' })).toThrow('12 digits')
	})

	test("applying it ensures GitHub's provider first, then the stack, and answers the role the stack names", async () => {
		const calls: string[] = []
		const iam: IamGithubIdentity = {
			ensureGithubOidcProvider: async (accountId) => {
				calls.push(`provider ${accountId}`)
				return 'created'
			},
		}
		let outputs: Record<string, string> = { RoleArn: awsDeployerRoleArn(A) }
		let status: StackStatus | null = null
		let body = ''
		const cloudFormation = {
			findStack: async () => (status === null ? null : { stackId: 'stack-1', status }),
			describeStack: async () => ({ stackId: 'stack-1', status: status ?? 'CREATE_COMPLETE', outputs }),
			getTemplate: async () => body,
			createStack: async ({ name, templateBody }: { name: string; templateBody: string }) => {
				calls.push(`create ${name}`)
				status = 'CREATE_COMPLETE'
				body = templateBody
				return 'stack-1'
			},
			updateStack: async ({ name, templateBody }: { name: string; templateBody: string }) => {
				calls.push(`update ${name}`)
				status = 'UPDATE_COMPLETE'
				body = templateBody
				return 'stack-1'
			},
		}
		const lines: string[] = []
		const run = {
			input: INPUT,
			iam,
			cloudFormation,
			signal: new AbortController().signal,
			sleep: async () => {},
			log: (line: string) => lines.push(line),
		}
		expect(await applyAwsDeployer(run)).toBe(awsDeployerRoleArn(A))
		expect(calls).toEqual([`provider ${A}`, `create ${AWS_DEPLOYER_STACK}`])
		expect(lines).toContain(`aws: the deployer role ${awsDeployerRoleArn(A)} trusts repo:acme/fabrika-aws-production:environment:production alone`)
		// Run again: the template it holds is the one rendered, so nothing is updated.
		expect(await applyAwsDeployer(run)).toBe(awsDeployerRoleArn(A))
		expect(calls).toEqual([`provider ${A}`, `create ${AWS_DEPLOYER_STACK}`, `provider ${A}`])
		// A stack answering another role is never handed to a workflow.
		outputs = { RoleArn: `arn:aws:iam::${A}:role/other` }
		await expect(applyAwsDeployer(run)).rejects.toThrow(`answers arn:aws:iam::${A}:role/other`)
	})
})
