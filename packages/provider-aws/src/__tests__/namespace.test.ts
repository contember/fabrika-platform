// The AWS provider's deployment namespaces over a fake of their AWS calls: the names derived from the namespace's id
// and environment, a target that is always the installation's, the namespace's stack (the proxy's group, admitting
// nothing yet, and the Service Connect namespace), provision and reconcile applying it, the claims of a namespace and of
// an environment placed in it, and each claim read back before Control may release it.

import type { JsonValue, ProviderDeploymentNamespace, ProviderNamespaceMutationInput } from '@fabrika/provider-contract'
import { ProviderNamespaceError } from '@fabrika/provider-contract'
import { describe, expect, test } from 'bun:test'
import type { StackDescription, StackSummary } from '../aws/cloudformation'
import type { EcsService } from '../aws/ecs'
import { AwsError } from '../aws/transport'
import { awsAppArtifactCodec, type AwsAppTarget, awsNamespaceTargetCodec } from '../codecs'
import { awsNamespaceCapabilities, awsNamespaceResources, awsNamespaceStack, namespaceOutputsOf, readNamespaceOutputs } from '../namespace'
import { awsNamespaceMemberHosts } from '../proxy-manifest'
import { AWS_STACK_TIMEOUT_MS } from '../stack'

const installation: AwsAppTarget = {
	accountId: '123456789012',
	region: 'eu-central-1',
	cluster: 'fabrika-apps',
	sourcesBucket: 'fabrika-sources-123456789012',
}
const network = { vpcId: 'vpc-0123456789abcdef0', subnets: ['subnet-0123456789abcdef0'], publicIp: true }
const STACK_ID = 'arn:aws:cloudformation:eu-central-1:123456789012:stack/fabrika-ns-6-shared-prod/0f1e2d3c'
const OUTPUTS = {
	ProxySecurityGroupId: 'sg-0123456789abcdef7',
	ServiceConnectNamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-abcdefghij123456',
}

const target = (change: Record<string, string> = {}) => ({
	provider: 'aws',
	version: 1,
	payload: awsNamespaceTargetCodec.encode({
		accountId: '123456789012',
		region: 'eu-central-1',
		stackName: 'fabrika-ns-6-shared-prod',
		sizing: 'cheap',
		...change,
	}),
})
const NAMESPACE: ProviderDeploymentNamespace = { id: 'shared', env: 'prod', target: target() }

/** `value[key]` of a JSON object, or undefined for anything else. */
function at(value: JsonValue | undefined, ...keys: readonly string[]): JsonValue | undefined {
	let current = value
	for (const key of keys) current = typeof current === 'object' && current !== null && !Array.isArray(current) ? current[key] : undefined
	return current
}

/** A fake of the namespace's calls: a stack that is absent until created, then serves; a service; parameter names. */
class Fake {
	readonly calls: string[] = []
	stack: 'absent' | 'serving' = 'absent'
	template = ''
	service: EcsService['status'] | null = null
	parameters: string[] = []
	readonly clients = {
		cloudFormation: {
			findStack: async (name: string): Promise<StackSummary | null> => {
				this.calls.push(`findStack ${name}`)
				return this.stack === 'absent' ? null : { stackId: STACK_ID, status: 'CREATE_COMPLETE' }
			},
			describeStack: async (stackId: string): Promise<StackDescription> => {
				this.calls.push('describeStack')
				return { stackId, status: 'CREATE_COMPLETE', outputs: OUTPUTS }
			},
			getTemplate: async (): Promise<string> => this.template,
			createStack: async (input: { readonly name: string; readonly templateBody: string; readonly tags: Readonly<Record<string, string>> }) => {
				this.calls.push(`createStack ${input.name} ${JSON.stringify(input.tags)}`)
				this.template = input.templateBody
				this.stack = 'serving'
				return STACK_ID
			},
			updateStack: async (): Promise<string> => {
				throw new Error('no update expected')
			},
		},
		ecs: {
			describeService: async (address: { readonly cluster: string; readonly service: string }): Promise<EcsService | null> => {
				this.calls.push(`describeService ${address.cluster}/${address.service}`)
				if (this.service === null) return null
				return {
					name: address.service,
					arn: `arn:aws:ecs:eu-central-1:123456789012:service/${address.cluster}/${address.service}`,
					status: this.service,
					taskDefinitionArn: 'arn:aws:ecs:eu-central-1:123456789012:task-definition/notes_prod:1',
					deployments: [],
					currentDeploymentArn: null,
					network: null,
					events: [],
				}
			},
		},
		ssm: {
			listNames: async (path: string): Promise<readonly string[]> => {
				this.calls.push(`listNames ${path}`)
				return this.parameters
			},
		},
	}
	readonly capabilities = awsNamespaceCapabilities({ installation, network, clients: this.clients, sleep: async () => {} })
}

const mutation = (namespace: ProviderDeploymentNamespace = NAMESPACE): ProviderNamespaceMutationInput => ({
	namespace,
	members: [],
	signal: new AbortController().signal,
	events: { checkpoint: async () => {}, boundary: async () => {} },
})

describe('awsNamespaceResources', () => {
	test("names the stack and the Service Connect namespace from the id and the environment, the id's length between", () => {
		expect(awsNamespaceResources('shared', 'prod')).toEqual({
			stackName: 'fabrika-ns-6-shared-prod',
			serviceConnectNamespace: 'fabrika-ns-6-shared-prod',
		})
		// `a-b` + `c` and `a` + `b-c` would join to one name without the length.
		expect(awsNamespaceResources('a-b', 'c').stackName).not.toBe(awsNamespaceResources('a', 'b-c').stackName)
		for (const [id, env] of [['Shared', 'prod'], ['a_b', 'prod'], ['shared', 'pr.od'], ['x'.repeat(64), 'prod']]) {
			expect(() => awsNamespaceResources(id ?? '', env ?? '')).toThrow('aws: the namespace id')
		}
	})
})

describe('awsNamespaceStack', () => {
	const stack = awsNamespaceStack(NAMESPACE, network)
	const resources = at(stack.template, 'Resources')

	test("holds the proxy's group in the installation's VPC, admitting nothing yet, and the Service Connect namespace", () => {
		expect(stack.stackName).toBe('fabrika-ns-6-shared-prod')
		const group = at(resources, 'ProxySecurityGroup', 'Properties')
		expect(at(resources, 'ProxySecurityGroup', 'Type')).toBe('AWS::EC2::SecurityGroup')
		expect(at(group, 'VpcId')).toBe('vpc-0123456789abcdef0')
		expect(at(group, 'SecurityGroupIngress')).toBeUndefined()
		expect(at(group, 'SecurityGroupEgress')).toEqual([{ IpProtocol: '-1', CidrIp: '0.0.0.0/0', Description: 'outbound' }])
		expect(at(resources, 'ServiceConnect', 'Type')).toBe('AWS::ServiceDiscovery::HttpNamespace')
		expect(at(resources, 'ServiceConnect', 'Properties', 'Name')).toBe('fabrika-ns-6-shared-prod')
		expect(stack.tags).toEqual({ 'fabrika:namespace': 'shared', 'fabrika:env': 'prod' })
		expect(at(stack.template, 'Outputs', 'ProxySecurityGroupId', 'Value')).toEqual({ 'Fn::GetAtt': ['ProxySecurityGroup', 'GroupId'] })
		expect(at(stack.template, 'Outputs', 'ServiceConnectNamespaceArn', 'Value')).toEqual({ 'Fn::GetAtt': ['ServiceConnect', 'Arn'] })
	})

	test('its outputs are read only of their form', () => {
		expect(namespaceOutputsOf('s', OUTPUTS)).toEqual({
			proxySecurityGroupId: OUTPUTS.ProxySecurityGroupId,
			serviceConnectNamespaceArn: OUTPUTS.ServiceConnectNamespaceArn,
		})
		expect(() => namespaceOutputsOf('s', { ...OUTPUTS, ProxySecurityGroupId: 'vpc-0123456789abcdef0' })).toThrow('names no proxy security group')
		expect(() => namespaceOutputsOf('s', { ProxySecurityGroupId: OUTPUTS.ProxySecurityGroupId })).toThrow('names no proxy security group')
	})
})

describe('awsNamespaceCapabilities', () => {
	test("a namespace's target is the installation's: normalize replaces it, and refuses one of another account, stack or size", () => {
		const { capabilities } = new Fake()
		expect(capabilities.normalize(NAMESPACE)).toEqual(NAMESPACE)
		const changes: readonly Record<string, string>[] = [
			{ accountId: '999999999999' },
			{ region: 'us-east-1' },
			{ stackName: 'fabrika-ns-5-other-prod' },
			{ sizing: 'full' },
		]
		for (const change of changes) expect(() => capabilities.normalize({ ...NAMESPACE, target: target(change) })).toThrow('aws:')
		expect(() => capabilities.normalize({ ...NAMESPACE, target: { ...NAMESPACE.target, provider: 'zerops' } })).toThrow()
	})

	test('provision creates the stack when absent; reconcile of a current stack changes nothing', async () => {
		const fake = new Fake()
		expect(await fake.capabilities.provision(mutation())).toEqual(NAMESPACE)
		expect(fake.calls).toEqual([
			'findStack fabrika-ns-6-shared-prod',
			'createStack fabrika-ns-6-shared-prod {"fabrika:namespace":"shared","fabrika:env":"prod"}',
			'describeStack',
		])
		fake.calls.length = 0
		expect(await fake.capabilities.reconcile(mutation())).toEqual(NAMESPACE)
		expect(fake.calls).toEqual(['findStack fabrika-ns-6-shared-prod', 'describeStack'])
	})

	test('a failed stack call is a namespace error with a stable code, never the error object', async () => {
		const fake = new Fake()
		fake.clients.cloudFormation.findStack = async () => {
			throw new AwsError('ListStacks', 'AccessDenied', 403, null, false)
		}
		const failure = await fake.capabilities.provision(mutation()).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(failure).toMatchObject({ code: 'awsCall', retryable: false, message: 'aws: ListStacks failed (AccessDenied)' })
		// A target of another account or size keeps its class too.
		const refused = await fake.capabilities.provision(mutation({ ...NAMESPACE, target: target({ sizing: 'full' }) })).catch((error: unknown) => error)
		expect(refused).toBeInstanceOf(ProviderNamespaceError)
		expect(refused).toMatchObject({ code: 'awsTarget', retryable: false, message: 'aws: only a cheap namespace is provisioned on AWS yet' })
	})

	test('a stack CloudFormation is still working on when the wait ends is retryable: a later reconcile settles it', async () => {
		const fake = new Fake()
		fake.stack = 'serving'
		fake.clients.cloudFormation.describeStack = async (stackId) => ({ stackId, status: 'CREATE_IN_PROGRESS', outputs: {} })
		fake.clients.cloudFormation.findStack = async () => ({ stackId: STACK_ID, status: 'CREATE_IN_PROGRESS' })
		let clock = 0
		const capabilities = awsNamespaceCapabilities({
			installation,
			network,
			clients: fake.clients,
			sleep: async () => {
				clock += AWS_STACK_TIMEOUT_MS
			},
			now: () => clock,
		})
		const failure = await capabilities.provision(mutation()).catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(ProviderNamespaceError)
		expect(failure).toMatchObject({ code: 'awsStackPending', retryable: true })
		// A stack an operator must repair stays a failure no reconcile settles.
		fake.clients.cloudFormation.findStack = async () => ({ stackId: STACK_ID, status: 'ROLLBACK_COMPLETE' })
		expect(await capabilities.provision(mutation()).catch((error: unknown) => error)).toMatchObject({ code: 'awsStack', retryable: false })
	})

	test('a namespace claims its stack; an environment placed in one, its stack, service and parameter path', () => {
		const { capabilities } = new Fake()
		expect(capabilities.namespaceResourceClaims(NAMESPACE)).toEqual(['stack:fabrika-ns-6-shared-prod'])
		const registration = {
			app: { id: 'notes', source: { repoUrl: 'https://github.com/example/notes', ref: 'main' } },
			environment: {
				appId: 'notes',
				env: 'prod',
				target: { provider: 'aws', version: 1, payload: {} },
				artifact: { provider: 'aws', version: 1, payload: {} },
			},
		}
		expect(capabilities.registrationResourceClaims(registration)).toEqual([
			'stack:fabrika-app-5-notes-prod',
			'service:fabrika-apps/notes_prod',
			'parameters:/fabrika/apps/notes/prod',
		])
	})

	test('a claim is gone only when its resource is: no stack, no active service, no secret parameter', async () => {
		const fake = new Fake()
		const keys = ['stack:fabrika-app-5-notes-prod', 'service:fabrika-apps/notes_prod', 'parameters:/fabrika/apps/notes/prod']
		const read = () => fake.capabilities.claimedResources?.({ namespace: NAMESPACE, resourceKeys: keys, signal: new AbortController().signal })
		expect(await read()).toEqual(keys.map((resourceKey) => ({ resourceKey, exists: false })))
		expect(fake.calls).toContain('listNames /fabrika/apps/notes/prod/env')
		fake.stack = 'serving'
		fake.service = 'active'
		fake.parameters = ['/fabrika/apps/notes/prod/env/01900000-0000-7000-8000-000000000001.API_TOKEN']
		expect(await read()).toEqual(keys.map((resourceKey) => ({ resourceKey, exists: true })))
		// A service ECS is still deleting holds its name: it exists.
		fake.service = 'draining'
		expect((await read())?.[1]).toEqual({ resourceKey: 'service:fabrika-apps/notes_prod', exists: true })
		// A service ECS keeps as deleted is gone.
		fake.service = 'inactive'
		expect((await read())?.[1]).toEqual({ resourceKey: 'service:fabrika-apps/notes_prod', exists: false })
		// A key of a kind this provider never made is no answer.
		await expect(
			fake.capabilities.claimedResources?.({ namespace: NAMESPACE, resourceKeys: ['bucket:x'], signal: new AbortController().signal }),
		).rejects.toThrow('a claim of a kind')
	})

	test("memberHosts is the proxy manifest's rule: an approved member's domain, none for one without approved access", () => {
		const { capabilities } = new Fake()
		const routing = {
			appId: 'notes',
			env: 'prod',
			domain: 'Notes.Example.com',
			artifact: {
				provider: 'aws',
				version: 1,
				payload: awsAppArtifactCodec.encode({ contractDigest: `sha256:${'a'.repeat(64)}`, healthPath: '/healthz' }),
			},
		}
		expect(capabilities.memberHosts).toBe(awsNamespaceMemberHosts)
		expect(capabilities.memberHosts?.(routing)).toEqual([])
	})

	test('the operator plans a cheap namespace of the installation and refuses any other preset or options', () => {
		const operator = new Fake().capabilities.operator
		const planned = operator?.plan({ id: 'shared', env: 'prod', preset: 'cheap' })
		expect(planned?.namespace).toEqual(NAMESPACE)
		expect(planned?.presentation.facts).toContainEqual({ label: 'Stack', value: 'fabrika-ns-6-shared-prod', resource: true })
		expect(() => operator?.plan({ id: 'shared', env: 'prod', preset: 'full' })).toThrow('only the cheap preset')
		expect(() => operator?.plan({ id: 'shared', env: 'prod', preset: 'cheap', options: { size: 1 } })).toThrow('takes no options')
	})
})

describe('readNamespaceOutputs', () => {
	test("reads a serving namespace's outputs, and names the remedy for one without a stack", async () => {
		const fake = new Fake()
		const signal = new AbortController().signal
		await expect(readNamespaceOutputs(fake.clients.cloudFormation, NAMESPACE, installation, signal)).rejects.toThrow(
			'the namespace shared has no stack yet; reconcile the namespace',
		)
		fake.stack = 'serving'
		expect(await readNamespaceOutputs(fake.clients.cloudFormation, NAMESPACE, installation, signal)).toEqual({
			proxySecurityGroupId: OUTPUTS.ProxySecurityGroupId,
			serviceConnectNamespaceArn: OUTPUTS.ServiceConnectNamespaceArn,
		})
		// A stack a reconcile is still at work on does not serve yet, and the deploy is told to run again.
		fake.clients.cloudFormation.describeStack = async (stackId) => ({ stackId, status: 'UPDATE_IN_PROGRESS', outputs: {} })
		await expect(readNamespaceOutputs(fake.clients.cloudFormation, NAMESPACE, installation, signal)).rejects.toThrow(
			"the namespace shared's stack is being created or updated (a reconcile is at work); deploy again once it serves",
		)
		// One an operator must repair says so.
		fake.clients.cloudFormation.describeStack = async (stackId) => ({ stackId, status: 'UPDATE_ROLLBACK_FAILED', outputs: {} })
		await expect(readNamespaceOutputs(fake.clients.cloudFormation, NAMESPACE, installation, signal)).rejects.toThrow(
			'is UPDATE_ROLLBACK_FAILED; an operator must repair or delete it',
		)
	})
})
