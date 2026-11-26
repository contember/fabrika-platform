// The installation's own networks (the AWS idea's checklist, step 11): two VPCs, each in two availability zones,
// created by the installation, never adopted, each from a stack the operator applies (`fabrika platform install`) with
// the operator's credentials; Control's role reaches no `fabrika-platform-*` stack.
//
// - **The platform's network apart from the applications'** (decided 2026-11-26). Control's role creates and updates
//   the applications' services, and ECS joins a service's tasks to whatever target group it names with ECS's own role:
//   no condition key of Control's policy names a target group. In one VPC an application's task could so join the
//   platform proxy's target group and be sent IAM's, Control's and Operations' requests. Two VPCs whose ranges share no
//   address, with no route between them (`checkAwsNetworksApart`), leave such a target unreachable, keep every security
//   group of the platform's VPC off an application's task, and keep the database out of the applications' network.
// - **Two kinds of subnet, apart, in each.** The tasks' subnets and the balancers' subnets, which hold nothing but the
//   balancers' nodes (and a NAT gateway, if an installation ever adds one). A namespace proxy trusts `X-Forwarded-For` from the balancers' subnets alone
//   (`AwsInstallationBalancer.balancerSubnetCidrs`); a task in one of them could choose the client address its requests
//   are seen from. So the layout is fixed here, the two kinds never overlap (`checkAwsNetworkLayout`), and Control is
//   told both (`awsNetworkEnvironment`).
// - **Public subnets, no NAT gateway.** Every task gets a public address (`FABRIKA_AWS_TASK_PUBLIC_IP=true`) behind an
//   ingress-free or proxy-only security group: cheaper than a NAT gateway up to about seven tasks. The balancers are
//   internet-facing, so their subnets route to the internet gateway as well.
// - **Each VPC's range is the operator's choice** (a /16, so it can avoid a range the operator peers with); the subnets
//   are derived from it: the tasks' two /20s at its start, the balancers' two /24s near its end. Control's variables
//   name the applications' network alone (`awsNetworkEnvironment`).
//
// UNVERIFIED: the resources' properties follow the CloudFormation reference; none was checked against an account. So
// does that `Fn::GetAZs` answers at least two zones, which it may not: it answers only the zones where the account's
// default VPC keeps a default subnet (all of the region's when it keeps none), so an account whose default VPC has a
// default subnet in one zone alone fails the stack at `Fn::Select [1, …]`. The operator guide names that; the zones can
// become a layout parameter if an account needs it.

import type { JsonValue } from '@fabrika/provider-contract'
import { blockAt, blockContains, blockOf, blocksOverlap, isNetworkAddress, VPC_CIDR } from '../cidr'
import type { AwsStack } from '../stack'

/**
 * The installation's two networks: the applications' (every application's and namespace proxy's tasks, and the
 * applications' balancer) and the platform's (IAM's, Control's, Operations' and the platform proxy's tasks, the
 * platform's balancer, the database).
 */
export type AwsNetworkSide = 'apps' | 'platform'
/** Each network's stack: under `fabrika-platform-`, which no grant of Control's role names. */
export const AWS_NETWORK_STACKS: Readonly<Record<AwsNetworkSide, string>> = {
	apps: 'fabrika-platform-network-apps',
	platform: 'fabrika-platform-network-platform',
}
/** Each VPC's range when the operator names none: two /16s apart. */
export const AWS_DEFAULT_VPC_CIDR = '10.80.0.0/16'
export const AWS_DEFAULT_PLATFORM_VPC_CIDR = '10.81.0.0/16'
/** The availability zones the network spans: two, the fewest an Application Load Balancer takes. */
const ZONES = 2

/** The installation's address plan: the VPC's range and each kind of subnet's, one per zone. */
export interface AwsNetworkLayout {
	readonly vpcCidr: string
	/** The tasks' subnets: the applications' and namespace proxies', or the platform's services', by the network's side. */
	readonly taskSubnetCidrs: readonly string[]
	/** The balancers' own subnets: nothing else runs in them, so a namespace proxy can trust what comes from them. */
	readonly balancerSubnetCidrs: readonly string[]
}

/** The layout of `vpcCidr`, a /16 named by its network address; the tasks' and the balancers' subnets never overlap. */
export function awsNetworkLayout(vpcCidr: string = AWS_DEFAULT_VPC_CIDR): AwsNetworkLayout {
	checkVpcCidr(vpcCidr)
	const zones = Array.from({ length: ZONES }, (_, zone) => zone)
	return checkAwsNetworkLayout({
		vpcCidr,
		taskSubnetCidrs: zones.map((zone) => blockAt(vpcCidr, zone * 4096, 20)),
		balancerSubnetCidrs: zones.map((zone) => blockAt(vpcCidr, (240 + zone) * 256, 24)),
	})
}

function checkVpcCidr(vpcCidr: string): void {
	if (!VPC_CIDR.test(vpcCidr) || !isNetworkAddress(vpcCidr) || blockOf(vpcCidr).prefix !== 16) {
		throw new Error("aws: the installation's VPC range is not a /16 named by its network address")
	}
}

/**
 * `layout` as given, or an error: the VPC's range a /16, one subnet per zone of each kind, each inside it, and no two
 * subnets sharing an address, above all no task's subnet overlapping a balancer's.
 */
export function checkAwsNetworkLayout(layout: AwsNetworkLayout): AwsNetworkLayout {
	checkVpcCidr(layout.vpcCidr)
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

/**
 * `apps` and `platform` as given, or an error: two VPCs whose ranges share no address, so nothing of one is ever an
 * address of the other (no route joins them, and none could be added without a grant Control's role does not hold).
 */
export function checkAwsNetworksApart(apps: AwsNetworkLayout, platform: AwsNetworkLayout): void {
	checkAwsNetworkLayout(apps)
	checkAwsNetworkLayout(platform)
	if (blocksOverlap(apps.vpcCidr, platform.vpcCidr)) throw new Error("aws: the applications' and the platform's VPC ranges overlap")
}

/** The network's stack of one side: the VPC, its internet gateway and one public route table, and the subnets of `layout`. */
export function awsNetworkStack(layout: AwsNetworkLayout, side: AwsNetworkSide): AwsStack {
	checkAwsNetworkLayout(layout)
	const resources: Record<string, JsonValue> = {
		Vpc: {
			Type: 'AWS::EC2::VPC',
			// DNS names inside the VPC: the database's endpoint and the tasks' registry and API calls resolve through them.
			Properties: { CidrBlock: layout.vpcCidr, EnableDnsSupport: true, EnableDnsHostnames: true, Tags: name(`fabrika-${side}`) },
		},
		InternetGateway: { Type: 'AWS::EC2::InternetGateway', Properties: { Tags: name(`fabrika-${side}`) } },
		InternetGatewayAttachment: {
			Type: 'AWS::EC2::VPCGatewayAttachment',
			Properties: { VpcId: { Ref: 'Vpc' }, InternetGatewayId: { Ref: 'InternetGateway' } },
		},
		PublicRouteTable: { Type: 'AWS::EC2::RouteTable', Properties: { VpcId: { Ref: 'Vpc' }, Tags: name(`fabrika-${side}-public`) } },
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
	layout.taskSubnetCidrs.forEach((cidr, index) => subnet(`TaskSubnet${index}`, cidr, index, `fabrika-${side}-tasks-${index}`))
	layout.balancerSubnetCidrs.forEach((cidr, index) => subnet(`BalancerSubnet${index}`, cidr, index, `fabrika-${side}-balancers-${index}`))
	const join = (prefix: string, count: number, value: (logical: string) => JsonValue): JsonValue => ({
		'Fn::Join': [',', Array.from({ length: count }, (_, index) => value(`${prefix}${index}`))],
	})
	const ids = (logical: string): JsonValue => ({ Ref: logical })
	const ranges = (logical: string): JsonValue => ({ 'Fn::GetAtt': [logical, 'CidrBlock'] })
	return {
		stackName: AWS_NETWORK_STACKS[side],
		template: {
			AWSTemplateFormatVersion: '2010-09-09',
			Description: `fabrika: the installation's ${side === 'apps' ? "applications'" : "platform's"} network`,
			Resources: resources,
			// The ranges as AWS created them, beside the ids: Control is told what the subnets are, checked again
			// (`awsNetworkEnvironment`), never only what the layout meant them to be.
			Outputs: {
				VpcId: { Value: { Ref: 'Vpc' } },
				VpcCidr: { Value: { 'Fn::GetAtt': ['Vpc', 'CidrBlock'] } },
				TaskSubnetIds: { Value: join('TaskSubnet', layout.taskSubnetCidrs.length, ids) },
				TaskSubnetCidrs: { Value: join('TaskSubnet', layout.taskSubnetCidrs.length, ranges) },
				BalancerSubnetIds: { Value: join('BalancerSubnet', layout.balancerSubnetCidrs.length, ids) },
				BalancerSubnetCidrs: { Value: join('BalancerSubnet', layout.balancerSubnetCidrs.length, ranges) },
			},
		},
		tags: { 'fabrika:platform': `network-${side}` },
	}
}

/** What the network's stack created: the ids AWS chose, and each subnet's range as AWS reports it, in order. */
export interface AwsNetworkOutputs {
	readonly vpcId: string
	readonly vpcCidr: string
	readonly taskSubnetIds: readonly string[]
	readonly taskSubnetCidrs: readonly string[]
	readonly balancerSubnetIds: readonly string[]
	readonly balancerSubnetCidrs: readonly string[]
}

const SUBNET_ID = /^subnet-[0-9a-f]{8,17}$/

/**
 * The network's outputs as the stack answers them, or an error naming the output of another form: one subnet id per
 * zone of each kind, none twice and none of both kinds, and the ranges a layout of their own (`checkAwsNetworkLayout`),
 * so no task's subnet overlaps a balancer's in what AWS created either.
 */
export function awsNetworkOutputs(outputs: Readonly<Record<string, string>>): AwsNetworkOutputs {
	const vpcId = outputs['VpcId'] ?? ''
	const list = (key: string): readonly string[] => (outputs[key] ?? '').split(',').filter((id) => id !== '')
	if (!/^vpc-[0-9a-f]{8,17}$/.test(vpcId)) throw new Error("aws: the network stack's VpcId output is not a VPC id")
	const taskSubnetIds = list('TaskSubnetIds')
	const balancerSubnetIds = list('BalancerSubnetIds')
	for (const [key, ids] of [['TaskSubnetIds', taskSubnetIds], ['BalancerSubnetIds', balancerSubnetIds]] satisfies [string, readonly string[]][]) {
		if (ids.length !== ZONES || !ids.every((id) => SUBNET_ID.test(id))) {
			throw new Error(`aws: the network stack's ${key} output is not ${ZONES} subnet ids`)
		}
	}
	const all = [...taskSubnetIds, ...balancerSubnetIds]
	if (new Set(all).size !== all.length) {
		throw new Error("aws: the network stack's outputs name one subnet twice, or one as both a task's and a balancer's")
	}
	const network: AwsNetworkOutputs = {
		vpcId,
		vpcCidr: outputs['VpcCidr'] ?? '',
		taskSubnetIds,
		taskSubnetCidrs: list('TaskSubnetCidrs'),
		balancerSubnetIds,
		balancerSubnetCidrs: list('BalancerSubnetCidrs'),
	}
	checkAwsNetworkLayout(network)
	return network
}

const sameList = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((value, index) => value === b[index])

/**
 * Control's variables for the applications' network (`packages/control/src/aws/provider.ts`): where the tasks it starts
 * run, with a public address, and the ranges a namespace proxy is scoped to and trusts, all from what AWS created. The
 * platform's network is never Control's to place anything in. Refused when those
 * ranges are not the layout's: a stack that drifted, or was applied from another layout, never reaches Control.
 */
export function awsNetworkEnvironment(layout: AwsNetworkLayout, outputs: AwsNetworkOutputs): Readonly<Record<string, string>> {
	checkAwsNetworkLayout(layout)
	checkAwsNetworkLayout(outputs)
	if (
		outputs.vpcCidr !== layout.vpcCidr || !sameList(outputs.taskSubnetCidrs, layout.taskSubnetCidrs)
		|| !sameList(outputs.balancerSubnetCidrs, layout.balancerSubnetCidrs)
	) {
		throw new Error("aws: the network stack's ranges are not the installation's layout")
	}
	return {
		FABRIKA_AWS_VPC_ID: outputs.vpcId,
		FABRIKA_AWS_SUBNETS: outputs.taskSubnetIds.join(','),
		FABRIKA_AWS_TASK_PUBLIC_IP: 'true',
		FABRIKA_AWS_VPC_CIDR: outputs.vpcCidr,
		FABRIKA_AWS_BALANCER_SUBNET_CIDRS: outputs.balancerSubnetCidrs.join(','),
	}
}
