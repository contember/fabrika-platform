// The installation's ceilings. The platform's (P) is read by a small evaluator of explicit denials, which reads
// `NotAction`, `NotResource` and `StringNotEquals` conditions as IAM does (a key absent from the request matches no value,
// so a negated condition holds): each test states what P refuses, with and without the keys a request carries, and what
// an upgrade still does. Every platform role and the deployer carry P; the applications' ceiling (A) writes no role.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { AWS_MAX_MANAGED_POLICY, awsAccessStack, awsAppsBoundaryStatements, awsPlatformBoundaryArn } from '../access'
import { awsPlatformAccessInput } from '../apply'
import { AWS_CEILINGS_STACK, AWS_DEPLOYER_STACK, awsCeilingsStack, awsDeployerRoleArn, awsPlatformBoundaryStatements } from '../ceilings'
import { awsDeployerStack } from '../deployer'
import { awsImagesStack } from '../images'
import { awsRuntimeStack } from '../runtime'
import { platformState } from './platform-fixture'

const A = '123456789012'
const P = awsPlatformBoundaryArn(A)
const APPS = `arn:aws:iam::${A}:policy/fabrika/fabrika-apps-boundary`
const PROVIDER = `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`
const role = (path: string) => `arn:aws:iam::${A}:role/${path}`

interface Statement {
	readonly Effect: string
	readonly Action?: string | readonly string[]
	readonly NotAction?: readonly string[]
	readonly Resource?: string | readonly string[]
	readonly NotResource?: readonly string[]
	readonly Condition?: Readonly<Record<string, Readonly<Record<string, string | readonly string[]>>>>
}

const listOf = (
	value: string | readonly string[] | undefined,
): readonly string[] => (value === undefined ? [] : typeof value === 'string' ? [value] : value)
const glob = (pattern: string, value: string): boolean =>
	new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`).test(value)

/** Whether `statement`'s condition holds for a request carrying `context`. Only the operators P uses are read. */
function conditionHolds(statement: Statement, context: Readonly<Record<string, string>>): boolean {
	for (const [operator, keys] of Object.entries(statement.Condition ?? {})) {
		if (operator !== 'StringNotEquals') throw new Error(`the evaluator does not read ${operator}`)
		for (const [key, values] of Object.entries(keys)) {
			const value = context[key]
			if (value !== undefined && listOf(values).includes(value)) return false
		}
	}
	return true
}

/** Whether `statements` refuse `action` on `resource` for a request carrying `context`, by an explicit denial. */
function deniedBy(statements: readonly Statement[], action: string, resource: string, context: Readonly<Record<string, string>> = {}): boolean {
	return statements.some((statement) => {
		if (statement.Effect !== 'Deny') return false
		const acts = statement.NotAction === undefined
			? listOf(statement.Action).some((pattern) => glob(pattern, action))
			: !statement.NotAction.some((pattern) => glob(pattern, action))
		if (!acts) return false
		const covers = statement.NotResource === undefined
			? listOf(statement.Resource).some((pattern) => glob(pattern, resource))
			: !statement.NotResource.some((pattern) => glob(pattern, resource))
		return covers && conditionHolds(statement, context)
	})
}

const statements: readonly Statement[] = JSON.parse(JSON.stringify(awsPlatformBoundaryStatements(A)))
const denied = (action: string, resource: string, context: Readonly<Record<string, string>> = {}) => deniedBy(statements, action, resource, context)

/** Every role a template creates, with its boundary. */
function roles(template: JsonValue): { name: string; boundary: unknown }[] {
	const resources: Record<string, { Type: string; Properties: { RoleName?: string; PermissionsBoundary?: unknown } }> =
		JSON.parse(JSON.stringify(template)).Resources
	return Object.values(resources)
		.filter((resource) => resource.Type === 'AWS::IAM::Role')
		.map((resource) => ({ name: resource.Properties.RoleName ?? '', boundary: resource.Properties.PermissionsBoundary }))
}

const ROLE_WRITES = [
	'iam:CreateRole',
	'iam:PutRolePolicy',
	'iam:AttachRolePolicy',
	'iam:DetachRolePolicy',
	'iam:DeleteRolePolicy',
	'iam:PutRolePermissionsBoundary',
]

describe("the platform's ceiling", () => {
	test('a role is written only where it carries P or A; a boundary is never removed', () => {
		for (const action of ROLE_WRITES) {
			const target = role('fabrika/platform/x')
			expect({ action, none: denied(action, target), foreign: denied(action, target, { 'iam:PermissionsBoundary': `arn:aws:iam::${A}:policy/admin` }) })
				.toEqual({ action, none: true, foreign: true })
			expect({ action, p: denied(action, target, { 'iam:PermissionsBoundary': P }), a: denied(action, target, { 'iam:PermissionsBoundary': APPS }) })
				.toEqual({ action, p: false, a: false })
		}
		expect(denied('iam:DeleteRolePermissionsBoundary', role('fabrika/apps/x'))).toBe(true)
		// Outside `/fabrika/`, not even a role carrying a ceiling is written.
		for (const action of ROLE_WRITES) {
			expect({ action, denied: denied(action, role('outside'), { 'iam:PermissionsBoundary': P }) }).toEqual({ action, denied: true })
		}
		// Re-trusting and tagging take no boundary key: held to `/fabrika/` by resource.
		for (const action of ['iam:UpdateAssumeRolePolicy', 'iam:TagRole', 'iam:UntagRole']) {
			expect({ action, outside: denied(action, role('OrganizationAccountAccessRole')), inside: denied(action, role('fabrika/apps/x')) })
				.toEqual({ action, outside: true, inside: false })
		}
	})

	test("the ceilings, the deployer and GitHub's provider are out of reach; their stacks are only read", () => {
		for (const action of ['iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicyVersion', 'iam:DeletePolicy']) {
			expect({ action, p: denied(action, P), a: denied(action, APPS) }).toEqual({ action, p: true, a: true })
		}
		// Outside `/fabrika/`, no policy is made, versioned, set back to an older version or deleted.
		for (
			const action of ['iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:DeletePolicyVersion', 'iam:DeletePolicy']
		) {
			expect({ action, denied: denied(action, `arn:aws:iam::${A}:policy/admin`) }).toEqual({ action, denied: true })
		}
		expect(denied('iam:CreatePolicyVersion', `arn:aws:iam::${A}:policy/fabrika/platform/fabrika-control-core`)).toBe(false)
		for (const action of ['iam:UpdateAssumeRolePolicy', 'iam:AttachRolePolicy', 'iam:DeleteRole', 'iam:PassRole']) {
			expect({ action, denied: denied(action, awsDeployerRoleArn(A), { 'iam:PermissionsBoundary': P }) }).toEqual({ action, denied: true })
		}
		expect(denied('iam:AddClientIDToOpenIDConnectProvider', PROVIDER)).toBe(true)
		for (const stack of [AWS_CEILINGS_STACK, AWS_DEPLOYER_STACK]) {
			const arn = `arn:aws:cloudformation:eu-central-1:${A}:stack/${stack}/1`
			for (
				const action of ['cloudformation:UpdateStack', 'cloudformation:DeleteStack', 'cloudformation:CreateChangeSet', 'cloudformation:ExecuteChangeSet']
			) {
				expect({ stack, action, denied: denied(action, arn) }).toEqual({ stack, action, denied: true })
			}
			expect({ stack, read: denied('cloudformation:DescribeStacks', arn) || denied('cloudformation:GetTemplate', arn) }).toEqual({ stack, read: false })
		}
	})

	test('no user, group, long-lived credential or identity provider', () => {
		for (
			const action of [
				'iam:CreateUser',
				'iam:CreateGroup',
				'iam:AddUserToGroup',
				'iam:AttachUserPolicy',
				'iam:PutUserPolicy',
				'iam:PutGroupPolicy',
				'iam:DeleteUserPermissionsBoundary',
				'iam:CreateAccessKey',
				'iam:CreateLoginProfile',
				'iam:ResetServiceSpecificCredential',
				'iam:UploadSSHPublicKey',
				'iam:DeactivateMFADevice',
				'iam:CreateOpenIDConnectProvider',
				'iam:CreateSAMLProvider',
				'rolesanywhere:CreateTrustAnchor',
				'sso:CreatePermissionSet',
				'identitystore:CreateUser',
				'cognito-identity:SetIdentityPoolRoles',
			]
		) {
			expect({ action, denied: denied(action, '*') }).toEqual({ action, denied: true })
		}
	})

	test("a role is passed only under /fabrika/ and only to the installation's services; none is assumed; the account is out of reach", () => {
		for (const service of ['ecs-tasks.amazonaws.com', 'codebuild.amazonaws.com', 'lambda.amazonaws.com']) {
			expect({ service, denied: denied('iam:PassRole', role('fabrika/platform/x'), { 'iam:PassedToService': service }) }).toEqual({
				service,
				denied: false,
			})
		}
		// As a stack's service role, to an instance, or without the service named: refused.
		for (const service of ['cloudformation.amazonaws.com', 'ec2.amazonaws.com']) {
			expect({ service, denied: denied('iam:PassRole', role('fabrika/platform/x'), { 'iam:PassedToService': service }) }).toEqual({
				service,
				denied: true,
			})
		}
		expect(denied('iam:PassRole', role('fabrika/platform/x'))).toBe(true)
		expect(denied('iam:PassRole', role('someone-elses'), { 'iam:PassedToService': 'lambda.amazonaws.com' })).toBe(true)
		expect(denied('sts:AssumeRole', role('fabrika/platform/x'))).toBe(true)
		for (const action of ['organizations:LeaveOrganization', 'account:CloseAccount', 'iam:CreateAccountAlias', 'iam:UpdateAccountPasswordPolicy']) {
			expect({ action, denied: denied(action, '*') }).toEqual({ action, denied: true })
		}
	})

	test('it leaves what an upgrade and Control do', () => {
		expect(denied('cloudformation:UpdateStack', `arn:aws:cloudformation:eu-central-1:${A}:stack/fabrika-platform-services/1`)).toBe(false)
		expect(denied('iam:CreateServiceLinkedRole', role('aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS'))).toBe(false)
		expect(denied('iam:UpdateAssumeRolePolicy', role('fabrika/apps/x'))).toBe(false)
		for (
			const action of [
				'codebuild:StartBuild',
				'ecs:RunTask',
				'ecs:UpdateService',
				'ssm:PutParameter',
				'acm:DescribeCertificate',
				'sts:GetCallerIdentity',
			]
		) {
			expect({ action, denied: denied(action, '*') }).toEqual({ action, denied: false })
		}
	})

	test("it fits IAM's bound on a managed policy", () => {
		expect(JSON.stringify({ Version: '2012-10-17', Statement: awsPlatformBoundaryStatements(A) }).length).toBeLessThanOrEqual(AWS_MAX_MANAGED_POLICY)
	})
})

describe("the applications' ceiling", () => {
	test('it writes no role or policy, passes none and assumes none: never wider than P', () => {
		const apps: readonly Statement[] = JSON.parse(JSON.stringify(awsAppsBoundaryStatements({ accountId: A, region: 'eu-central-1' })))
		const actions = apps.flatMap((statement) => [...listOf(statement.Action), ...(statement.NotAction ?? [])])
		expect(actions.length).toBeGreaterThan(0)
		expect(actions.filter((action) => action === '*' || action.startsWith('iam:') || action.startsWith('sts:') || action.endsWith(':*'))).toEqual([])
	})
})

describe('the ceilings stack', () => {
	test('both ceilings at the ARNs every role names', () => {
		const resources = JSON.parse(JSON.stringify(awsCeilingsStack({ accountId: A, region: 'eu-central-1' }).template)).Resources
		expect(resources.PlatformBoundary.Properties).toMatchObject({ ManagedPolicyName: 'fabrika-platform-boundary', Path: '/fabrika/platform/' })
		expect(resources.AppsBoundary.Properties).toMatchObject({ ManagedPolicyName: 'fabrika-apps-boundary', Path: '/fabrika/' })
		expect(resources.AppsBoundary.Properties.PolicyDocument.Statement).toEqual(
			JSON.parse(JSON.stringify(awsAppsBoundaryStatements({ accountId: A, region: 'eu-central-1' }))),
		)
		expect(Object.keys(resources).sort()).toEqual(['AppsBoundary', 'PlatformBoundary'])
	})

	test('every platform role, and the deployer, carries the platform ceiling', () => {
		const state = platformState()
		const templates = [
			awsAccessStack(awsPlatformAccessInput(state)).template,
			awsImagesStack({ accountId: A, region: 'eu-central-1' }).template,
			awsRuntimeStack({
				accountId: A,
				region: 'eu-central-1',
				platform: state.platform,
				balancers: { platformBalancerGroupId: state.balancers.platformBalancerGroupId },
			}).template,
			awsDeployerStack({ accountId: A, repository: 'acme/fabrika-aws', repositoryOwnerId: '1', repositoryId: '2', environment: 'production' })
				.template,
		]
		const all = templates.flatMap(roles)
		expect(all.length).toBeGreaterThanOrEqual(7)
		expect(all.filter((entry) => entry.boundary !== P)).toEqual([])
	})
})
