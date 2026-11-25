// One application environment's stack: its resources carry the names the deploy derives, every role reaches only that
// environment's resources (the one action without a resource aside), every trust policy names its service and this
// account, and two environments' stacks share no resource.

import type { JsonValue } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import { MAX_TEMPLATE_BYTES, type StackStatus, type StackSummary } from '../aws/cloudformation'
import { ecrLifecyclePolicy } from '../aws/ecr'
import { AwsError } from '../aws/transport'
import { AWS_BUILDSPEC } from '../build'
import type { AwsAppTarget } from '../codecs'
import { AWS_BUILD_IMAGE, AWS_STACK_TIMEOUT_MS, awsAppsPermissionsBoundary, awsEnvironmentStack, ensureEnvironmentStack } from '../environment-stack'
import { AWS_KEPT_IMAGES } from '../resources'

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

const STACK_ID = 'arn:aws:cloudformation:eu-central-1:123456789012:stack/fabrika-app-5-notes-prod/0f1e2d3c'

/**
 * A scripted CloudFormation: each read (`findStack` by name, `describeStack` by id) answers the next of `states` (the
 * last one repeats; `null` is no stack, which a read by id answers as `DELETE_COMPLETE`), `getTemplate` answers
 * `template`. `readErrors` are thrown by the next reads first. Every call is recorded.
 */
class FakeCloudFormation {
	readonly calls: string[] = []
	template = ''
	createError: AwsError | null = null
	readonly readErrors: AwsError[] = []
	constructor(private readonly states: (StackStatus | null)[]) {}

	private next(call: string): StackStatus | null {
		this.calls.push(call)
		const error = this.readErrors.shift()
		if (error !== undefined) throw error
		return (this.states.length > 1 ? this.states.shift() : this.states[0]) ?? null
	}

	readonly client = {
		findStack: async (): Promise<StackSummary | null> => {
			const status = this.next('findStack')
			return status === null ? null : { stackId: STACK_ID, status }
		},
		describeStack: async (stackId: string): Promise<{ readonly stackId: string; readonly status: StackStatus | 'DELETE_COMPLETE' }> => {
			const status = this.next('describeStack')
			return { stackId, status: status ?? 'DELETE_COMPLETE' }
		},
		getTemplate: async (): Promise<string> => {
			this.calls.push('getTemplate')
			return this.template
		},
		createStack: async (
			input: { readonly name: string; readonly templateBody: string; readonly tags: Readonly<Record<string, string>> },
		): Promise<string> => {
			this.calls.push(`createStack ${input.name} ${JSON.stringify(input.tags)}`)
			if (this.createError !== null) throw this.createError
			this.template = input.templateBody
			return STACK_ID
		},
		updateStack: async (input: { readonly templateBody: string }): Promise<string> => {
			this.calls.push('updateStack')
			this.template = input.templateBody
			return 'id'
		},
	}
}

describe('ensureEnvironmentStack', () => {
	const stack = awsEnvironmentStack('notes', 'prod', installation)
	const body = JSON.stringify(stack.template)
	const ensure = (fake: FakeCloudFormation, change: { now?: () => number } = {}) => {
		const lines: string[] = []
		const run = ensureEnvironmentStack({
			cloudFormation: fake.client,
			stack,
			signal: new AbortController().signal,
			sleep: async () => {},
			log: (line) => lines.push(line),
			newToken: () => 'token-1',
			...change,
		})
		return { run, lines }
	}

	test('an absent stack is created with its tags and waited for', async () => {
		const fake = new FakeCloudFormation([null, 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE'])
		const { run, lines } = ensure(fake)
		await run
		expect(fake.calls).toEqual([
			'findStack',
			`createStack fabrika-app-5-notes-prod {"fabrika:app":"notes","fabrika:env":"prod"}`,
			// From the create on, the stack is read by the id its answer named.
			'describeStack',
			'describeStack',
			'getTemplate',
		])
		expect(lines).toEqual(['aws: creating the stack fabrika-app-5-notes-prod', 'aws: the stack fabrika-app-5-notes-prod is current'])
	})

	test('a current stack is read and left alone: an unchanged update is never sent', async () => {
		const fake = new FakeCloudFormation(['UPDATE_COMPLETE'])
		fake.template = body
		await ensure(fake).run
		expect(fake.calls).toEqual(['findStack', 'getTemplate'])
	})

	test('a stack holding another template is updated and waited for', async () => {
		const fake = new FakeCloudFormation(['CREATE_COMPLETE', 'UPDATE_IN_PROGRESS', 'UPDATE_COMPLETE'])
		fake.template = '{"older":true}'
		await ensure(fake).run
		expect(fake.calls).toEqual(['findStack', 'getTemplate', 'updateStack', 'describeStack', 'describeStack', 'getTemplate'])
	})

	test('a template that answers equal as JSON (keys reordered, spaced) is current: no no-op update is sent', async () => {
		const fake = new FakeCloudFormation(['UPDATE_COMPLETE'])
		const reordered = Object.fromEntries(Object.entries(stack.template ?? {}).reverse())
		fake.template = JSON.stringify(reordered, null, 2)
		await ensure(fake).run
		expect(fake.calls).toEqual(['findStack', 'getTemplate'])
		// A body that is not JSON is no match: the stack is updated, never wedged.
		const odd = new FakeCloudFormation(['UPDATE_COMPLETE'])
		odd.template = 'Resources: {}'
		await ensure(odd).run
		expect(odd.calls).toContain('updateStack')
	})

	test('a read refused for rate or with a lost answer is read again at the next poll', async () => {
		const fake = new FakeCloudFormation(['UPDATE_COMPLETE'])
		fake.template = body
		fake.readErrors.push(new AwsError('ListStacks', 'Throttling', 400, null, true), new AwsError('ListStacks', 'timeout', 0, null, true))
		await ensure(fake).run
		expect(fake.calls).toEqual(['findStack', 'findStack', 'findStack', 'getTemplate'])
		const refused = new FakeCloudFormation(['UPDATE_COMPLETE'])
		refused.readErrors.push(new AwsError('ListStacks', 'AccessDenied', 403, null, false))
		await expect(ensure(refused).run).rejects.toMatchObject({ code: 'AccessDenied' })
	})

	test('a create that fails before the first read is reported as failed, not as a timeout', async () => {
		const fake = new FakeCloudFormation([null, null])
		await expect(ensure(fake).run).rejects.toThrow('creating the stack fabrika-app-5-notes-prod failed')
		// Deleted inside the first poll: the read by id answers DELETE_COMPLETE at once.
		expect(fake.calls).toEqual(['findStack', `createStack fabrika-app-5-notes-prod {"fabrika:app":"notes","fabrika:env":"prod"}`, 'describeStack'])
	})

	test("the rendered template stays well under CloudFormation's inline limit, and one past it is named", async () => {
		expect(new TextEncoder().encode(JSON.stringify(stack.template)).byteLength).toBeLessThan(MAX_TEMPLATE_BYTES / 2)
		const fake = new FakeCloudFormation([null])
		const big = { ...stack, template: { Resources: { Padding: 'x'.repeat(MAX_TEMPLATE_BYTES) } } }
		await expect(
			ensureEnvironmentStack({ cloudFormation: fake.client, stack: big, signal: new AbortController().signal, sleep: async () => {}, log: () => {} }),
		)
			.rejects.toThrow(`past the ${MAX_TEMPLATE_BYTES} CloudFormation takes inline`)
		expect(fake.calls).toEqual([])
	})

	test('a stack another creator won is waited for, not created again', async () => {
		const fake = new FakeCloudFormation([null, 'CREATE_IN_PROGRESS', 'CREATE_COMPLETE'])
		fake.createError = new AwsError('CreateStack', 'AlreadyExistsException', 400, null, false)
		fake.template = body
		await ensure(fake).run
		expect(fake.calls.filter((call) => call.startsWith('createStack'))).toHaveLength(1)
	})

	test("the run's own update rolled back, a create that failed, and a stack an operator must repair are refused", async () => {
		const rolledBack = new FakeCloudFormation(['CREATE_COMPLETE', 'UPDATE_ROLLBACK_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE'])
		rolledBack.template = '{"older":true}'
		await expect(ensure(rolledBack).run).rejects.toThrow('rolled it back')
		const deleted = new FakeCloudFormation([null, 'CREATE_IN_PROGRESS', 'DELETE_IN_PROGRESS', null])
		await expect(ensure(deleted).run).rejects.toThrow('creating the stack fabrika-app-5-notes-prod failed')
		for (const status of ['ROLLBACK_COMPLETE', 'UPDATE_ROLLBACK_FAILED', 'DELETE_FAILED', 'REVIEW_IN_PROGRESS'] satisfies StackStatus[]) {
			const stuck = new FakeCloudFormation([status])
			await expect(ensure(stuck).run).rejects.toThrow(`is ${status}; an operator must repair or delete it`)
			expect(stuck.calls).toEqual(['findStack'])
		}
	})

	test('a stack that does not settle within the bound fails the wait', async () => {
		const fake = new FakeCloudFormation(['UPDATE_IN_PROGRESS'])
		let clock = 0
		const now = () => {
			clock += AWS_STACK_TIMEOUT_MS / 4
			return clock
		}
		await expect(ensure(fake, { now }).run).rejects.toThrow('did not settle')
	})
})
