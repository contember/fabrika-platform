// The installation's two balancers: the applications' (a fixed default answer, the listener namespaces' rules go on)
// and the platform's (a rule per platform host to the platform proxy), both appending X-Forwarded-For, reaching only the
// tasks' subnets, in the balancers' own subnets; their outputs read back, and the variables Control takes.

import { describe, expect, test } from 'bun:test'
import { checkInstallationBalancer } from '../../namespace'
import {
	AWS_BALANCERS_STACK,
	AWS_TLS_POLICY,
	awsBalancersEnvironment,
	type AwsBalancersInput,
	awsBalancersOutputs,
	awsBalancersStack,
	checkAwsBalancersInput,
} from '../balancers'
import { awsNetworkLayout, awsNetworkOutputs } from '../network'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210'
const TARGET_GROUP = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Platf-1A2B3C4D/0123456789abcdef'
const layout = awsNetworkLayout()
const input: AwsBalancersInput = {
	network: awsNetworkOutputs({
		VpcId: 'vpc-0123456789abcdef0',
		VpcCidr: '10.80.0.0/16',
		TaskSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
		TaskSubnetCidrs: '10.80.0.0/20,10.80.16.0/20',
		BalancerSubnetIds: 'subnet-0123456789abcdef2,subnet-0123456789abcdef3',
		BalancerSubnetCidrs: '10.80.240.0/24,10.80.241.0/24',
	}),
	hosts: { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com' },
	certificates: { iam: certificate(1), control: certificate(2), operations: certificate(3) },
}
const OUTPUTS = {
	AppsBalancerGroupId: 'sg-0123456789abcdef1',
	AppsHttpsListenerArn: LISTENER,
	AppsBalancerDnsName: 'fabrika-apps-1234567890.eu-central-1.elb.amazonaws.com',
	PlatformBalancerGroupId: 'sg-0123456789abcdef2',
	PlatformProxyTargetGroupArn: TARGET_GROUP,
	PlatformBalancerDnsName: 'fabrika-platform-1234567890.eu-central-1.elb.amazonaws.com',
}

describe("the installation's balancers", () => {
	const template = JSON.parse(JSON.stringify(awsBalancersStack(input).template))
	const resources = template.Resources

	test("both are internet-facing in the balancers' own subnets, append X-Forwarded-For and drop invalid header fields", () => {
		expect(awsBalancersStack(input).stackName).toBe(AWS_BALANCERS_STACK)
		for (const prefix of ['Apps', 'Platform']) {
			expect(resources[`${prefix}Balancer`].Properties).toMatchObject({
				Type: 'application',
				Scheme: 'internet-facing',
				Subnets: ['subnet-0123456789abcdef2', 'subnet-0123456789abcdef3'],
				SecurityGroups: [{ Ref: `${prefix}BalancerGroup` }],
				LoadBalancerAttributes: [
					{ Key: 'routing.http.xff_header_processing.mode', Value: 'append' },
					{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
				],
			})
		}
	})

	test("their groups admit the internet on 80 and 443, and reach only the tasks' subnets on the proxies' ports", () => {
		for (const prefix of ['Apps', 'Platform']) {
			const group = resources[`${prefix}BalancerGroup`].Properties
			expect(group.SecurityGroupIngress.map((rule: { FromPort: number; CidrIp: string }) => [rule.FromPort, rule.CidrIp])).toEqual([
				[80, '0.0.0.0/0'],
				[443, '0.0.0.0/0'],
			])
			expect(group.SecurityGroupEgress).toEqual(layout.taskSubnetCidrs.map((cidr) => ({
				IpProtocol: 'tcp',
				FromPort: 8080,
				ToPort: 8081,
				CidrIp: cidr,
				Description: 'the proxies',
			})))
		}
	})

	test('every listener answers a host nothing names with a fixed 404, never a forward; HTTP redirects to HTTPS', () => {
		for (const prefix of ['Apps', 'Platform']) {
			expect(resources[`${prefix}HttpsListener`].Properties).toMatchObject({
				Port: 443,
				Protocol: 'HTTPS',
				SslPolicy: AWS_TLS_POLICY,
				Certificates: [{ CertificateArn: certificate(1) }],
				DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '404' } }],
			})
			expect(resources[`${prefix}HttpListener`].Properties.DefaultActions).toEqual([
				{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } },
			])
		}
		// Nothing on the applications' listener but its default: the namespaces' stacks add their own rules.
		const appsRules = Object.values(resources).filter((resource) => JSON.stringify(resource).includes('"Ref":"AppsHttpsListener"'))
		expect(appsRules).toEqual([])
	})

	test("the platform's listener forwards each platform host alone to the platform proxy, with its certificate on first", () => {
		expect(resources.PlatformIamRule).toEqual({
			Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
			Properties: {
				ListenerArn: { Ref: 'PlatformHttpsListener' },
				Priority: 1,
				Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['iam.example.com'] } }],
				Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'PlatformProxyTargetGroup' } }],
			},
		})
		expect(resources.PlatformOperationsRule.DependsOn).toEqual(['PlatformOperationsCertificate'])
		expect(resources.PlatformOperationsRule.Properties.Priority).toBe(3)
		expect(resources.PlatformControlCertificate.Properties).toEqual({
			ListenerArn: { Ref: 'PlatformHttpsListener' },
			Certificates: [{ CertificateArn: certificate(2) }],
		})
		expect(resources.PlatformIamCertificate).toBeUndefined()
		expect(resources.PlatformProxyTargetGroup.Properties).toMatchObject({
			TargetType: 'ip',
			Port: 8080,
			HealthCheckPort: '8081',
			HealthCheckPath: '/healthz',
		})
	})

	test('hosts or certificates of another form, or one twice, are refused', () => {
		expect(() => checkAwsBalancersInput({ ...input, hosts: { ...input.hosts, control: 'Control.example.com' } })).toThrow('hosts')
		expect(() => checkAwsBalancersInput({ ...input, hosts: { ...input.hosts, control: 'iam.example.com' } })).toThrow('hosts')
		expect(() => checkAwsBalancersInput({ ...input, certificates: { ...input.certificates, control: certificate(1) } })).toThrow('certificates')
		expect(() => checkAwsBalancersInput({ ...input, certificates: { ...input.certificates, control: 'arn:aws:s3:::bucket' } })).toThrow('certificates')
	})

	test("the outputs are read back, and Control's variables pass its own check of the applications' balancer", () => {
		const outputs = awsBalancersOutputs(OUTPUTS)
		expect(outputs.appsListenerArn).toBe(LISTENER)
		expect(() => awsBalancersOutputs({ ...OUTPUTS, AppsHttpsListenerArn: TARGET_GROUP })).toThrow('AppsHttpsListenerArn')
		expect(() => awsBalancersOutputs({ ...OUTPUTS, PlatformBalancerDnsName: 'example.com' })).toThrow('PlatformBalancerDnsName')
		const environment = awsBalancersEnvironment(outputs, input.hosts)
		expect(environment).toEqual({
			FABRIKA_AWS_BALANCER_SECURITY_GROUP: 'sg-0123456789abcdef1',
			FABRIKA_AWS_BALANCER_LISTENER: LISTENER,
			FABRIKA_AWS_INSTALLATION_HOSTS: 'iam.example.com,control.example.com,operations.example.com',
		})
		expect(
			checkInstallationBalancer({
				securityGroupId: outputs.appsBalancerGroupId,
				vpcCidr: layout.vpcCidr,
				listenerArn: outputs.appsListenerArn,
				installationHosts: (environment['FABRIKA_AWS_INSTALLATION_HOSTS'] ?? '').split(','),
				balancerSubnetCidrs: layout.balancerSubnetCidrs,
			}).listenerArn,
		).toBe(LISTENER)
	})
})
