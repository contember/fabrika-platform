// The installation's own network (the AWS idea's checklist, step 11): one VPC in two availability zones, created by the
// installation, never adopted. Its stack is the operator's to apply (`fabrika platform install`), with the operator's
// credentials; Control's role reaches no `fabrika-platform-*` stack.
//
// - **Two kinds of subnet, apart.** The tasks' subnets (Control's, the platform's services', every application's and
//   namespace proxy's) and the balancers' subnets, which hold nothing but the balancers' nodes (and a NAT gateway, if an
//   installation ever adds one). A namespace proxy trusts `X-Forwarded-For` from the balancers' subnets alone
//   (`AwsInstallationBalancer.balancerSubnetCidrs`); a task in one of them could choose the client address its requests
//   are seen from. So the layout is fixed here, the two kinds never overlap (`checkAwsNetworkLayout`), and Control is
//   told both (`awsNetworkEnvironment`).
// - **Public subnets, no NAT gateway.** Every task gets a public address (`FABRIKA_AWS_TASK_PUBLIC_IP=true`) behind an
//   ingress-free or proxy-only security group: cheaper than a NAT gateway up to about seven tasks. The balancers are
//   internet-facing, so their subnets route to the internet gateway as well.
// - **The VPC's range is the operator's choice** (a /16, so it can avoid a range the operator peers with); the subnets
//   are derived from it: the tasks' two /20s at its start, the balancers' two /24s near its end.
//
// UNVERIFIED: the resources' properties and that `Fn::GetAZs` answers at least two zones follow the CloudFormation
// reference; none was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { blockAt, blockContains, blockOf, blocksOverlap, isNetworkAddress, VPC_CIDR } from '../cidr'
import type { AwsStack } from '../stack'

/** The network stack's name: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_NETWORK_STACK = 'fabrika-platform-network'
/** The VPC's range when the operator names none. */
export const AWS_DEFAULT_VPC_CIDR = '10.80.0.0/16'
/** The availability zones the network spans: two, the fewest an Application Load Balancer takes. */
const ZONES = 2

/** The installation's address plan: the VPC's range and each kind of subnet's, one per zone. */
export interface AwsNetworkLayout {
	readonly vpcCidr: string
	/** The tasks' subnets: Control's, the platform's services', every application's and namespace proxy's. */
	readonly taskSubnetCidrs: readonly string[]
	/** The balancers' own subnets: nothing else runs in them, so a namespace proxy can trust what comes from them. */
	readonly balancerSubnetCidrs: readonly string[]
}

/** The layout of `vpcCidr`, a /16 named by its network address; the tasks' and the balancers' subnets never overlap. */
export function awsNetworkLayout(vpcCidr: string = AWS_DEFAULT_VPC_CIDR): AwsNetworkLayout {
	if (!VPC_CIDR.test(vpcCidr) || !isNetworkAddress(vpcCidr) || blockOf(vpcCidr).prefix !== 16) {
		throw new Error("aws: the installation's VPC range is not a /16 named by its network address")
	}
	const zones = Array.from({ length: ZONES }, (_, zone) => zone)
	return checkAwsNetworkLayout({
		vpcCidr,
		taskSubnetCidrs: zones.map((zone) => blockAt(vpcCidr, zone * 4096, 20)),
		balancerSubnetCidrs: zones.map((zone) => blockAt(vpcCidr, (240 + zone) * 256, 24)),
	})
}

/**
 * `layout` as given, or an error: one subnet per zone of each kind, each inside the VPC's range, and no two subnets
 * sharing an address, above all no task's subnet overlapping a balancer's.
 */
export function checkAwsNetworkLayout(layout: AwsNetworkLayout): AwsNetworkLayout {
	const subnets = [...layout.taskSubnetCidrs, ...layout.balancerSubnetCidrs]
	if (
		layout.taskSubnetCidrs.length !== ZONES || layout.balancerSubnetCidrs.length !== ZONES
		|| !subnets.every((cidr) => VPC_CIDR.test(cidr) && isNetworkAddress(cidr) && blockContains(layout.vpcCidr, cidr))
		|| subnets.some((cidr, i) => subnets.some((other, j) => i !== j && blocksOverlap(cidr, other)))
	) {
		throw new Error("aws: the installation's subnets are not one per zone of each kind inside the VPC, or two of them overlap")
	}
	return layout
}

const zone = (index: number): JsonValue => ({ 'Fn::Select': [index, { 'Fn::GetAZs': '' }] })
const name = (value: string): JsonValue => [{ Key: 'Name', Value: value }]

/** The network's stack: the VPC, its internet gateway and one public route table, and the subnets of `layout`. */
export function awsNetworkStack(layout: AwsNetworkLayout): AwsStack {
	checkAwsNetworkLayout(layout)
	const resources: Record<string, JsonValue> = {
		Vpc: {
			Type: 'AWS::EC2::VPC',
			// DNS names inside the VPC: the database's endpoint and the tasks' registry and API calls resolve through them.
			Properties: { CidrBlock: layout.vpcCidr, EnableDnsSupport: true, EnableDnsHostnames: true, Tags: name('fabrika') },
		},
		InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: name('fabrika') } },
		InternetGatewayAttachment: {
			Type: 'AWS::EC2::VPCGatewayAttachment',
			Properties: { VpcId: { Ref: 'Vpc' }, InternetGatewayId: { Ref: 'InternetGateway' } },
		},
		PublicRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: 'Vpc' }, Tags: name('fabrika-public') } },
		PublicDefaultRoute: {
			Type: 'AWS::EC2::Route',
			// The route names the gateway, which only answers once it is attached.
			DependsOn: ['InternetGatewayAttachment'],
			Properties: { RouteTableId: { Ref: 'PublicRouteTable' }, DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: 'InternetGateway' } },
		},
	}
	const subnet = (logical: string, cidr: string, index: number, label: string): void => {
		resources[logical] = {
			Type: 'AWS::EC2::Subnet',
			// No address by default: ECS gives a task one when its service says so, and a balancer's nodes get their own.
			Properties: { VpcId: { Ref: 'Vpc' }, CidrBlock: cidr, AvailabilityZone: zone(index), MapPublicIpOnLaunch: false, Tags: name(label) },
		}
		resources[`${logical}Routes`] = {
			Type: 'AWS::EC2::SubnetRouteTableAssociation',
			Properties: { SubnetId: { Ref: logical }, RouteTableId: { Ref: 'PublicRouteTable' } },
		}
	}
	layout.taskSubnetCidrs.forEach((cidr, index) => subnet(`TaskSubnet${index}`, cidr, index, `fabrika-tasks-${index}`))
	layout.balancerSubnetCidrs.forEach((cidr, index) => subnet(`BalancerSubnet${index}`, cidr, index, `fabrika-balancers-${index}`))
	const join = (prefix: string, count: number): JsonValue => ({
		'Fn::Join': [',', Array.from({ length: count }, (_, index) => ({ Ref: `${prefix}${index}` }))],
	})
	return {
		stackName: AWS_NETWORK_STACK,
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: "fabrika: the installation's network",
			Resources: resources,
			Outputs: {
				VpcId: { Value: { Ref: 'Vpc' } },
				TaskSubnetIds: { Value: join('TaskSubnet', layout.taskSubnetCidrs.length) },
				BalancerSubnetIds: { Value: join('BalancerSubnet', layout.balancerSubnetCidrs.length) },
			},
		},
		tags: { 'fabrika:platform': 'network' },
	}
}

/** What the network's stack created under ids AWS chose. */
export interface AwsNetworkOutputs {
	readonly vpcId: string
	readonly taskSubnetIds: readonly string[]
	readonly balancerSubnetIds: readonly string[]
}

/** The network's outputs as the stack answers them, or an error naming the output of another form. */
export function awsNetworkOutputs(outputs: Readonly<Record<string, string>>): AwsNetworkOutputs {
	const vpcId = outputs['VpcId'] ?? ''
	const list = (key: string): readonly string[] => (outputs[key] ?? '').split(',').filter((id) => id !== '')
	const taskSubnetIds = list('TaskSubnetIds')
	const balancerSubnetIds = list('BalancerSubnetIds')
	if (!/^vpc-[0-9a-f]{8,17}$/.test(vpcId)) throw new Error("aws: the network stack's VpcId output is not a VPC id")
	for (const [key, ids] of [['TaskSubnetIds', taskSubnetIds], ['BalancerSubnetIds', balancerSubnetIds]] satisfies [string, readonly string[]][]) {
		if (ids.length !== ZONES || !ids.every((id) => /^subnet-[0-9a-f]{8,17}$/.test(id))) {
			throw new Error(`aws: the network stack's ${key} output is not ${ZONES} subnet ids`)
		}
	}
	return { vpcId, taskSubnetIds, balancerSubnetIds }
}

/**
 * Control's variables for the network (`packages/control/src/aws/provider.ts`): where its tasks run, with a public
 * address, and the ranges a namespace proxy is scoped to and trusts. The balancers' subnets are never among the tasks'.
 */
export function awsNetworkEnvironment(layout: AwsNetworkLayout, outputs: AwsNetworkOutputs): Readonly<Record<string, string>> {
	checkAwsNetworkLayout(layout)
	return {
		FABRIKA_AWS_VPC_ID: outputs.vpcId,
		FABRIKA_AWS_SUBNETS: outputs.taskSubnetIds.join(','),
		FABRIKA_AWS_TASK_PUBLIC_IP: 'true',
		FABRIKA_AWS_VPC_CIDR: layout.vpcCidr,
		FABRIKA_AWS_BALANCER_SUBNET_CIDRS: layout.balancerSubnetCidrs.join(','),
	}
}
