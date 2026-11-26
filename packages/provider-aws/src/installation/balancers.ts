// The installation's two balancers (the AWS idea's checklist, step 11), in the balancers' own subnets of its network
// (`network.ts`), from one stack the operator applies:
//
// - **The applications' balancer.** Every namespace's hosts are served on its HTTPS listener (`host-rules.ts`), each
//   namespace's stack adding its rules and certificates. Its default action is a fixed answer, never a forward, so a
//   host no rule names reaches no namespace. Its group is the one each namespace proxy's group admits (`namespace.ts`).
//   Control's role reaches this listener (step 11's grants) and nothing of the other balancer.
// - **The platform's balancer.** IAM's, Control's and Operations' hosts, each forwarded by a rule of its own to the
//   platform proxy's target group; its default action is a fixed answer too. Apart from the applications', so no grant
//   of Control's role reaches a listener that routes the platform's hosts (decided 2026-11-26).
//
// Both keep `routing.http.xff_header_processing.mode` at `append`, written explicitly: a namespace proxy trusts the
// balancers' subnets, and only a balancer that appends its peer's address keeps that trust from being forged (with
// `preserve`, the caller's own header would reach the proxy as it sent it). Both drop header fields that are not valid
// HTTP, and answer plain HTTP with a redirect to HTTPS. Their groups admit the internet on 80 and 443 and reach only the
// tasks' subnets, on the proxies' ports.
//
// Each listener needs a default certificate, which a balancer serves to every client whose SNI matches no other: the
// platform's listener takes IAM's. The applications' listener takes a certificate of its own, for a host that is none of
// the platform's (`appsDefault`), never a platform host's: with one, the applications' balancer would complete TLS for
// that host, and a rule on its listener (which Control's role can write) would serve it. A client the default answers
// gets the fixed 404 either way. All four certificates are the operator's, validated before the stack is applied.
//
// UNVERIFIED: the resources' properties, the attribute keys and the security policy's name follow the CloudFormation and
// Elastic Load Balancing references; none was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { CERTIFICATE_ARN, CERTIFICATE_HOST } from '../aws/acm'
import { TARGET_GROUP_ARN } from '../aws/ecs'
import { LISTENER_ARN } from '../aws/elb'
import { AWS_PROXY_HEALTH_PATH, AWS_PROXY_HEALTH_PORT, AWS_PROXY_PORT } from '../namespace'
import type { AwsStack } from '../stack'
import { type AwsNetworkOutputs, checkAwsNetworkLayout } from './network'

/** The balancers' stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_BALANCERS_STACK = 'fabrika-platform-balancers'
/** The listeners' TLS policy: TLS 1.3, and 1.2 with forward-secret ciphers only. */
export const AWS_TLS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06'

/** The platform's services behind its proxy, each at a host of its own. */
export type AwsPlatformService = 'iam' | 'control' | 'operations'
export const AWS_PLATFORM_SERVICES: readonly AwsPlatformService[] = ['iam', 'control', 'operations']
/** One value per platform service. */
export type AwsPlatformRecord<T> = Readonly<Record<AwsPlatformService, T>>

export interface AwsBalancersInput {
	/** The network as AWS created it (`awsNetworkOutputs`): its balancers' subnets, and its tasks' ranges the groups reach. */
	readonly network: AwsNetworkOutputs
	/** Each platform service's public host, lower-case. */
	readonly hosts: AwsPlatformRecord<string>
	/** Each platform host's issued ACM certificate, in the installation's region. */
	readonly certificates: AwsPlatformRecord<string>
	/**
	 * The applications' listener's default certificate and the host it is for: a host of its own (the applications'
	 * domain's, say), none of the platform's, so the applications' balancer never completes TLS for a platform host.
	 */
	readonly appsDefault: { readonly host: string; readonly certificate: string }
}

/** `input` as given, or an error naming the part of another form (never a value). */
export function checkAwsBalancersInput(input: AwsBalancersInput): AwsBalancersInput {
	checkAwsNetworkLayout(input.network)
	const hosts = AWS_PLATFORM_SERVICES.map((service) => input.hosts[service])
	if (!hosts.every((host) => CERTIFICATE_HOST.test(host)) || new Set(hosts).size !== hosts.length) {
		throw new Error("aws: the platform's hosts are not three distinct lower-case host names")
	}
	const certificates = AWS_PLATFORM_SERVICES.map((service) => input.certificates[service])
	if (!certificates.every((arn) => CERTIFICATE_ARN.test(arn)) || new Set(certificates).size !== certificates.length) {
		throw new Error("aws: the platform's certificates are not three distinct ACM certificate ARNs")
	}
	const { appsDefault } = input
	if (
		!CERTIFICATE_HOST.test(appsDefault.host) || hosts.includes(appsDefault.host) || !CERTIFICATE_ARN.test(appsDefault.certificate)
		|| certificates.includes(appsDefault.certificate)
	) {
		throw new Error("aws: the applications' default certificate is not one of its own, for a host that is none of the platform's")
	}
	return input
}

const pascal = (service: AwsPlatformService): string => `${service.charAt(0).toUpperCase()}${service.slice(1)}`
const name = (value: string): JsonValue => [{ Key: 'Name', Value: value }]
const NOT_FOUND: JsonValue = {
	Type: 'fixed-response',
	FixedResponseConfig: { StatusCode: '404', ContentType: 'text/plain', MessageBody: 'Not found' },
}

/** The balancers' stack: both balancers, their groups and listeners, and the platform proxy's target group and rules. */
export function awsBalancersStack(input: AwsBalancersInput): AwsStack {
	const { network, hosts, certificates, appsDefault } = checkAwsBalancersInput(input)
	const resources: Record<string, JsonValue> = {}
	const balancer = (prefix: 'Apps' | 'Platform', label: string, defaultCertificate: string): void => {
		resources[`${prefix}BalancerGroup`] = {
			Type: 'AWS::EC2::SecurityGroup',
			Properties: {
				GroupDescription: `fabrika: the ${label} balancer`,
				VpcId: network.vpcId,
				SecurityGroupIngress: [80, 443].map((port) => ({
					IpProtocol: 'tcp',
					FromPort: port,
					ToPort: port,
					CidrIp: '0.0.0.0/0',
					Description: port === 80 ? 'redirected to HTTPS' : 'HTTPS',
				})),
				// The proxies alone, in the tasks' subnets: the public port and the health route's, each a rule of its own.
				SecurityGroupEgress: network.taskSubnetCidrs.flatMap((cidr) =>
					[AWS_PROXY_PORT, AWS_PROXY_HEALTH_PORT].map((port) => ({
						IpProtocol: 'tcp',
						FromPort: port,
						ToPort: port,
						CidrIp: cidr,
						Description: port === AWS_PROXY_PORT ? 'the proxies' : 'the proxies health checks',
					}))
				),
				Tags: name(`fabrika-${label}-balancer`),
			},
		}
		resources[`${prefix}Balancer`] = {
			Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
			Properties: {
				Type: 'application',
				Scheme: 'internet-facing',
				IpAddressType: 'ipv4',
				Subnets: [...network.balancerSubnetIds],
				SecurityGroups: [{ Ref: `${prefix}BalancerGroup` }],
				LoadBalancerAttributes: [
					{ Key: 'routing.http.xff_header_processing.mode', Value: 'append' },
					{ Key: 'routing.http.drop_invalid_header_fields.enabled', Value: 'true' },
				],
				Tags: name(`fabrika-${label}`),
			},
		}
		resources[`${prefix}HttpsListener`] = {
			Type: 'AWS::ElasticLoadBalancingV2::Listener',
			Properties: {
				LoadBalancerArn: { Ref: `${prefix}Balancer` },
				Port: 443,
				Protocol: 'HTTPS',
				SslPolicy: AWS_TLS_POLICY,
				Certificates: [{ CertificateArn: defaultCertificate }],
				DefaultActions: [NOT_FOUND],
			},
		}
		resources[`${prefix}HttpListener`] = {
			Type: 'AWS::ElasticLoadBalancingV2::Listener',
			Properties: {
				LoadBalancerArn: { Ref: `${prefix}Balancer` },
				Port: 80,
				Protocol: 'HTTP',
				DefaultActions: [{ Type: 'redirect', RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' } }],
			},
		}
	}
	balancer('Apps', 'applications', appsDefault.certificate)
	balancer('Platform', 'platform', certificates.iam)
	resources['PlatformProxyTargetGroup'] = {
		Type: 'AWS::ElasticLoadBalancingV2::TargetGroup',
		Properties: {
			TargetType: 'ip',
			Protocol: 'HTTP',
			Port: AWS_PROXY_PORT,
			VpcId: network.vpcId,
			HealthCheckProtocol: 'HTTP',
			HealthCheckPort: String(AWS_PROXY_HEALTH_PORT),
			HealthCheckPath: AWS_PROXY_HEALTH_PATH,
			Matcher: { HttpCode: '200' },
			TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '30' }],
			Tags: name('fabrika-platform-proxy'),
		},
	}
	AWS_PLATFORM_SERVICES.forEach((service, index) => {
		// IAM's certificate is the listener's default; the others are added to it.
		if (service !== 'iam') {
			resources[`Platform${pascal(service)}Certificate`] = {
				Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
				Properties: { ListenerArn: { Ref: 'PlatformHttpsListener' }, Certificates: [{ CertificateArn: certificates[service] }] },
			}
		}
		resources[`Platform${pascal(service)}Rule`] = {
			Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
			...(service === 'iam' ? {} : { DependsOn: [`Platform${pascal(service)}Certificate`] }),
			Properties: {
				ListenerArn: { Ref: 'PlatformHttpsListener' },
				Priority: index + 1,
				Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [hosts[service]] } }],
				Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'PlatformProxyTargetGroup' } }],
			},
		}
	})
	return {
		stackName: AWS_BALANCERS_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the installation's balancers",
			Resources: resources,
			Outputs: {
				AppsBalancerGroupId: { Value: { 'Fn::GetAtt': ['AppsBalancerGroup', 'GroupId'] } },
				AppsHttpsListenerArn: { Value: { Ref: 'AppsHttpsListener' } },
				AppsBalancerDnsName: { Value: { 'Fn::GetAtt': ['AppsBalancer', 'DNSName'] } },
				PlatformBalancerGroupId: { Value: { 'Fn::GetAtt': ['PlatformBalancerGroup', 'GroupId'] } },
				PlatformProxyTargetGroupArn: { Value: { Ref: 'PlatformProxyTargetGroup' } },
				PlatformBalancerDnsName: { Value: { 'Fn::GetAtt': ['PlatformBalancer', 'DNSName'] } },
			},
		},
		tags: { 'fabrika:platform': 'balancers' },
	}
}

/** What the balancers' stack created under names AWS chose. */
export interface AwsBalancersOutputs {
	readonly appsBalancerGroupId: string
	readonly appsListenerArn: string
	/** Where the operator points every application's host (a CNAME). */
	readonly appsBalancerDnsName: string
	readonly platformBalancerGroupId: string
	readonly platformProxyTargetGroupArn: string
	/** Where the operator points the platform's three hosts. */
	readonly platformBalancerDnsName: string
}

const SECURITY_GROUP_ID = /^sg-[0-9a-f]{8,17}$/
/** A balancer's DNS name as Elastic Load Balancing gives it. */
const BALANCER_DNS_NAME = /^[a-z0-9][a-z0-9.-]{0,251}\.elb\.amazonaws\.com$/i

/** The balancers' outputs as the stack answers them, or an error naming the output of another form. */
export function awsBalancersOutputs(outputs: Readonly<Record<string, string>>): AwsBalancersOutputs {
	const read = (key: string, form: RegExp): string => {
		const value = outputs[key] ?? ''
		if (!form.test(value)) throw new Error(`aws: the balancers' stack's ${key} output is of another form`)
		return value
	}
	return {
		appsBalancerGroupId: read('AppsBalancerGroupId', SECURITY_GROUP_ID),
		appsListenerArn: read('AppsHttpsListenerArn', LISTENER_ARN),
		appsBalancerDnsName: read('AppsBalancerDnsName', BALANCER_DNS_NAME),
		platformBalancerGroupId: read('PlatformBalancerGroupId', SECURITY_GROUP_ID),
		platformProxyTargetGroupArn: read('PlatformProxyTargetGroupArn', TARGET_GROUP_ARN),
		platformBalancerDnsName: read('PlatformBalancerDnsName', BALANCER_DNS_NAME),
	}
}

/**
 * Control's variables for the applications' balancer (`packages/control/src/aws/provider.ts`): the group each
 * namespace proxy admits, the listener every namespace's hosts go on, and the installation's own hosts, which no
 * namespace may take even on that listener: IAM's, Control's (the console's), Operations' and the applications' default
 * certificate's.
 */
export function awsBalancersEnvironment(
	outputs: AwsBalancersOutputs,
	input: Pick<AwsBalancersInput, 'hosts' | 'appsDefault'>,
): Readonly<Record<string, string>> {
	return {
		FABRIKA_AWS_BALANCER_SECURITY_GROUP: outputs.appsBalancerGroupId,
		FABRIKA_AWS_BALANCER_LISTENER: outputs.appsListenerArn,
		FABRIKA_AWS_INSTALLATION_HOSTS: [...AWS_PLATFORM_SERVICES.map((service) => input.hosts[service]), input.appsDefault.host].join(','),
	}
}
