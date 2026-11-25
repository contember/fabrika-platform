// One application environment's stack: its resources carry the names the deploy derives, every role reaches only that
// environment's resources (the one action without a resource aside), every trust policy names its service and this
// account, and two environments' stacks share no resource.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { ecrLifecyclePolicy } from '../aws/ecr'
import { AWS_BUILDSPEC } from '../build'
import type { AwsAppTarget } from '../codecs'
import { AWS_KEPT_IMAGES } from '../control'
import { AWS_BUILD_IMAGE, awsAppsPermissionsBoundary, awsEnvironmentStack } from '../environment-stack'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}

/** `value[key]` of a JSON object, or undefined for anything else. */
function at(value: JsonValue | undefined, ...keys: readonly (string | number)[]): JsonValue | undefined {
	let current = value
	for (const key of keys) {
		if (typeof key === 'number') current = Array.isArray(current) ? current[key] : undefined
		else current = typeof current === 'object' && current !== null && !Array.isArray(current) ? current[key] : undefined
	}
	return current
}

const list = (value: JsonValue | undefined): readonly JsonValue[] => Array.isArray(value) ? value : []
const strings = (value: JsonValue | undefined): readonly string[] =>
	typeof value === 'string' ? [value] : list(value).filter((item) => typeof item === 'string')

/** Every allowed action with the resources it is allowed on, over every role's inline policies. */
function grants(
	template: JsonValue,
): readonly { readonly role: string; readonly actions: readonly string[]; readonly resources: readonly string[] }[] {
	const found: { role: string; actions: readonly string[]; resources: readonly string[] }[] = []
	const resources = at(template, 'Resources')
	for (const role of ['TaskRole', 'ExecutionRole', 'BuildRole']) {
		for (const inline of list(at(resources, role, 'Properties', 'Policies'))) {
			for (const statement of list(at(inline, 'PolicyDocument', 'Statement'))) {
				expect(at(statement, 'Effect')).toBe('Allow')
				found.push({ role, actions: strings(at(statement, 'Action')), resources: strings(at(statement, 'Resource')) })
			}
		}
	}
	return found
}

describe('awsEnvironmentStack', () => {
	const stack = awsEnvironmentStack('notes', 'prod', installation)
	const resources = at(stack.template, 'Resources')

	test('its resources carry the names the deploy derives', () => {
		expect(stack.stackName).toBe('fabrika-app-5-notes-prod')
		expect(at(resources, 'Repository', 'Properties', 'RepositoryName')).toBe('fabrika/apps/notes/prod')
		expect(at(resources, 'Repository', 'Properties', 'ImageTagMutability')).toBe('IMMUTABLE')
		expect(at(resources, 'LogGroup', 'Properties', 'LogGroupName')).toBe('/fabrika/apps/notes/prod')
		expect(at(resources, 'BuildLogGroup', 'Properties', 'LogGroupName')).toBe('/fabrika/apps/notes/prod/build')
		expect(at(resources, 'TaskRole', 'Properties', 'RoleName')).toBe('notes_prod_task')
		expect(at(resources, 'ExecutionRole', 'Properties', 'RoleName')).toBe('notes_prod_execution')
		expect(at(resources, 'BuildRole', 'Properties', 'RoleName')).toBe('notes_prod_build')
		for (const role of ['TaskRole', 'ExecutionRole', 'BuildRole']) expect(at(resources, role, 'Properties', 'Path')).toBe('/fabrika/apps/')
		expect(`arn:aws:iam::123456789012:role/fabrika/apps/notes_prod_build`).toBe(stack.resources.buildRoleArn)
	})

	test('the build project is its own: its role, the deploy buildspec, privileged ARM, its own log group', () => {
		const project = at(resources, 'BuildProject', 'Properties')
		expect(at(project, 'Name')).toBe('fabrika_notes_prod')
		expect(at(project, 'ServiceRole')).toEqual({ 'Fn::GetAtt': ['BuildRole', 'Arn'] })
		expect(at(project, 'Source')).toEqual({ Type: 'NO_SOURCE', BuildSpec: AWS_BUILDSPEC })
		expect(at(project, 'Environment')).toEqual({
			Type: 'ARM_CONTAINER',
			ComputeType: 'BUILD_GENERAL1_SMALL',
			Image: AWS_BUILD_IMAGE,
			PrivilegedMode: true,
		})
		expect(at(project, 'LogsConfig', 'CloudWatchLogs', 'GroupName')).toBe('/fabrika/apps/notes/prod/build')
	})

	test('every role reaches only this environment: the login token is the one action without a resource', () => {
		const own = [
			'arn:aws:ecr:eu-central-1:123456789012:repository/fabrika/apps/notes/prod',
			'arn:aws:logs:eu-central-1:123456789012:log-group:/fabrika/apps/notes/prod:*',
			'arn:aws:logs:eu-central-1:123456789012:log-group:/fabrika/apps/notes/prod/build:*',
			'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/apps/notes/prod/env/*',
			'arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/apps/notes/prod/builds/*',
		]
		const all = grants(stack.template)
		expect(all.length).toBeGreaterThan(0)
		for (const grant of all) {
			if (grant.resources.includes('*')) expect(grant).toEqual({ role: grant.role, actions: ['ecr:GetAuthorizationToken'], resources: ['*'] })
			else for (const resource of grant.resources) expect(own).toContain(resource)
			for (const action of grant.actions) expect(action.includes('*')).toBe(false)
		}
		// The task role holds nothing yet; the execution role reads secrets, the build only its URL parameters.
		expect(all.filter((grant) => grant.role === 'TaskRole')).toEqual([])
		const reads = (role: string) =>
			all.filter((grant) => grant.role === role && grant.actions.includes('ssm:GetParameters')).flatMap((grant) => grant.resources)
		expect(reads('ExecutionRole')).toEqual(['arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/apps/notes/prod/env/*'])
		expect(reads('BuildRole')).toEqual(['arn:aws:ssm:eu-central-1:123456789012:parameter/fabrika/apps/notes/prod/builds/*'])
		const pushes = all.filter((grant) => grant.actions.includes('ecr:PutImage'))
		expect(pushes.map((grant) => grant.role)).toEqual(['BuildRole'])
	})

	test('each trust policy names its service, this account and the resources that may take it', () => {
		const ecs = { ArnLike: { 'aws:SourceArn': 'arn:aws:ecs:eu-central-1:123456789012:*' } }
		const expected = {
			TaskRole: { service: 'ecs-tasks.amazonaws.com', source: ecs },
			ExecutionRole: { service: 'ecs-tasks.amazonaws.com', source: ecs },
			// Only this environment's own project: the role is the build's, not any project's of the account.
			BuildRole: {
				service: 'codebuild.amazonaws.com',
				source: { ArnEquals: { 'aws:SourceArn': 'arn:aws:codebuild:eu-central-1:123456789012:project/fabrika_notes_prod' } },
			},
		}
		for (const [role, { service, source }] of Object.entries(expected)) {
			expect(list(at(resources, role, 'Properties', 'AssumeRolePolicyDocument', 'Statement'))).toEqual([{
				Effect: 'Allow',
				Principal: { Service: service },
				Action: 'sts:AssumeRole',
				Condition: { StringEquals: { 'aws:SourceAccount': '123456789012' }, ...source },
			}])
		}
	})

	test("every role carries the installation's permissions boundary, so whoever applies the stack creates roles only inside it", () => {
		for (const role of ['TaskRole', 'ExecutionRole', 'BuildRole']) {
			expect(at(resources, role, 'Properties', 'PermissionsBoundary')).toBe(awsAppsPermissionsBoundary('123456789012'))
		}
		expect(awsAppsPermissionsBoundary('123456789012')).toBe('arn:aws:iam::123456789012:policy/fabrika/fabrika-apps-boundary')
	})

	test('the stack owns the repository with the lifecycle rule the deploy sends', () => {
		expect(at(resources, 'Repository', 'Properties', 'LifecyclePolicy', 'LifecyclePolicyText')).toBe(ecrLifecyclePolicy(AWS_KEPT_IMAGES))
	})

	test("two environments' stacks share no resource and no name", () => {
		const other = awsEnvironmentStack('notes', 'stage', installation)
		const scoped = (template: JsonValue) => new Set(grants(template).flatMap((grant) => grant.resources).filter((resource) => resource !== '*'))
		const mine = scoped(stack.template)
		for (const resource of scoped(other.template)) expect(mine.has(resource)).toBe(false)
		expect(other.stackName).not.toBe(stack.stackName)
		expect(at(other.template, 'Resources', 'BuildProject', 'Properties', 'Name')).toBe('fabrika_notes_stage')
	})
})
