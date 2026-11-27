// AWS renders the installation model (ADR-0092): a job's schedule as a loop's interval, the services' and the proxy's
// ports and health as the model states them, the security groups' service rules as exactly the model's `calls`, and
// the generated variables and the upgrade rule as the model's with Control's copy of the proxy key.

import { INSTALLATION_SECRET_VARIABLES, PLATFORM_SERVICES, type PlatformService } from '@fabrika/installation-init'
import { describe, expect, test } from 'bun:test'
import { AWS_GENERATED, AWS_UPGRADE_MAY_ADD, awsInstallationModel, awsJobInterval, isAwsDataVariable } from '../model'
import { awsNetworkOutputs } from '../network'
import { AWS_PLATFORM_PROXY_HEALTH_PORT, AWS_PLATFORM_PROXY_PORT, AWS_PLATFORM_SERVICE_PORT, awsRuntimeStack } from '../runtime'

const model = awsInstallationModel

describe('AWS renders the installation model', () => {
	test("a job's schedule is the interval of its loop, and a schedule no loop keeps is refused", () => {
		expect(awsJobInterval('* * * * *')).toBe(60)
		expect(awsJobInterval('*/5 * * * *')).toBe(300)
		expect(awsJobInterval('0 3 * * *')).toBe(86_400)
		for (const schedule of ['0 */2 * * *', '0 3 * * 1', '@daily', '*/0 * * * *']) expect(() => awsJobInterval(schedule)).toThrow('none a loop runs')
		for (const service of PLATFORM_SERVICES) {
			for (const job of model.services[service].jobs) expect(() => awsJobInterval(job.schedule)).not.toThrow()
		}
	})

	test("the runtime's ports are the model's", () => {
		const services: readonly PlatformService[] = ['iam', 'control', 'operations']
		for (const service of services) {
			expect(model.services[service].ports.map((port) => port.port)).toEqual([AWS_PLATFORM_SERVICE_PORT])
		}
		expect(model.services.proxy.ports.map((port) => port.port)).toEqual([AWS_PLATFORM_PROXY_PORT, AWS_PLATFORM_PROXY_HEALTH_PORT])
		expect(model.services.proxy.health.port).toBe(AWS_PLATFORM_PROXY_HEALTH_PORT)
	})

	test("each service-port rule of the security groups is one of the model's calls, and each call has its rule", () => {
		const platform = awsNetworkOutputs({
			VpcId: 'vpc-0123456789abcdef9',
			VpcCidr: '10.81.0.0/16',
			TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
			TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
			BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
			BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
		})
		const stack = awsRuntimeStack({
			accountId: '123456789012',
			region: 'eu-central-1',
			platform,
			balancers: { platformBalancerGroupId: 'sg-0123456789abcdef9' },
		})
		const groupOf = (reference: unknown): string => {
			const parsed: { 'Fn::GetAtt'?: [string, string] } = typeof reference === 'object' && reference !== null
				? JSON.parse(JSON.stringify(reference))
				: {}
			return parsed['Fn::GetAtt']?.[0]?.replace(/Group$/, '').toLowerCase() ?? ''
		}
		const resources: Record<string, { Type: string; Properties: Record<string, unknown> }> = JSON.parse(JSON.stringify(stack.template)).Resources
		const pairs = (type: string, direction: 'egress' | 'ingress'): string[] =>
			Object.values(resources)
				.filter((resource) => resource.Type === type && resource.Properties['FromPort'] === AWS_PLATFORM_SERVICE_PORT)
				.map(({ Properties: rule }) =>
					direction === 'egress'
						? `${groupOf(rule['GroupId'])}>${groupOf(rule['DestinationSecurityGroupId'])}`
						: `${groupOf(rule['SourceSecurityGroupId'])}>${groupOf(rule['GroupId'])}`
				)
				.sort()
		const calls = PLATFORM_SERVICES.flatMap((service) => model.services[service].calls.map((callee) => `${service}>${callee}`)).sort()
		expect(pairs('AWS::EC2::SecurityGroupEgress', 'egress')).toEqual(calls)
		expect(pairs('AWS::EC2::SecurityGroupIngress', 'ingress')).toEqual(calls)
	})

	test("the generated variables are installation-init's and Control's copy of the proxy key; an upgrade adds IAM's data key alone", () => {
		for (const service of PLATFORM_SERVICES) {
			const expected = [...INSTALLATION_SECRET_VARIABLES[service], ...(service === 'control' ? ['FABRIKA_AWS_PROXY_IAM_KEY'] : [])]
			expect({ service, names: [...AWS_GENERATED[service].keys()].sort() }).toEqual({ service, names: expected.sort() })
		}
		expect(AWS_GENERATED.control.get('FABRIKA_AWS_PROXY_IAM_KEY')).toBe(AWS_GENERATED.iam.get('FABRIKA_IAM_PROXY_KEY'))
		expect([...AWS_UPGRADE_MAY_ADD]).toEqual(['dataKey'])
	})

	test("a store's coordinates are the model's data: a database's DSN and a bucket's prefix", () => {
		expect(isAwsDataVariable('iam', 'FABRIKA_IAM_DATABASE_URL')).toBe(true)
		expect(isAwsDataVariable('control', 'FABRIKA_CONTROL_RUN_LOGS_BUCKET')).toBe(true)
		expect(isAwsDataVariable('operations', 'FABRIKA_OPERATIONS_BLOB_BUCKET')).toBe(true)
		expect(isAwsDataVariable('control', 'FABRIKA_IAM_DATABASE_URL')).toBe(false)
		expect(isAwsDataVariable('iam', 'ISSUER')).toBe(false)
	})
})
