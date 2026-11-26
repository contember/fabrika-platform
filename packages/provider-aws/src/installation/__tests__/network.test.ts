// The installation's network: its address plan (the tasks' subnets never overlap the balancers', which a namespace
// proxy trusts), the stack rendered from it, its outputs read back, and the variables Control takes from both.

import { describe, expect, test } from 'bun:test'
import { checkInstallationBalancer } from '../../namespace'
import {
	AWS_DEFAULT_VPC_CIDR,
	AWS_NETWORK_STACK,
	awsNetworkEnvironment,
	awsNetworkLayout,
	awsNetworkOutputs,
	awsNetworkStack,
	checkAwsNetworkLayout,
} from '../network'

const OUTPUTS = {
	VpcId: 'vpc-0123456789abcdef0',
	VpcCidr: '10.80.0.0/16',
	TaskSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
	TaskSubnetCidrs: '10.80.0.0/20,10.80.16.0/20',
	BalancerSubnetIds: 'subnet-0123456789abcdef2,subnet-0123456789abcdef3',
	BalancerSubnetCidrs: '10.80.240.0/24,10.80.241.0/24',
}

describe("the installation's network", () => {
	test("the layout: the tasks' two /20s at the VPC's start, the balancers' two /24s near its end", () => {
		expect(awsNetworkLayout()).toEqual({
			vpcCidr: AWS_DEFAULT_VPC_CIDR,
			taskSubnetCidrs: ['10.80.0.0/20', '10.80.16.0/20'],
			balancerSubnetCidrs: ['10.80.240.0/24', '10.80.241.0/24'],
		})
		expect(awsNetworkLayout('172.20.0.0/16').balancerSubnetCidrs).toEqual(['172.20.240.0/24', '172.20.241.0/24'])
	})

	test('a VPC range that is not a /16 named by its network address is refused', () => {
		for (const cidr of ['10.80.0.0/17', '10.80.0.0/8', '10.80.1.0/16', '10.80.0.0', 'ten']) {
			expect(() => awsNetworkLayout(cidr)).toThrow('not a /16')
		}
	})

	test("a layout whose task subnet overlaps a balancer's, or that leaves the VPC, is refused", () => {
		const layout = awsNetworkLayout()
		for (
			const broken of [
				{ ...layout, taskSubnetCidrs: ['10.80.0.0/20', '10.80.240.0/20'] },
				{ ...layout, balancerSubnetCidrs: ['10.80.240.0/24', '10.80.0.0/24'] },
				{ ...layout, balancerSubnetCidrs: ['10.80.240.0/24', '10.81.241.0/24'] },
				{ ...layout, taskSubnetCidrs: ['10.80.0.0/20'] },
				{ ...layout, balancerSubnetCidrs: ['10.80.240.0/24', '10.80.240.0/24'] },
			]
		) {
			expect(() => checkAwsNetworkLayout(broken)).toThrow('overlap')
		}
	})

	test('the stack: a VPC, its gateway and public routes, and one subnet of each kind per zone, none with an address by default', () => {
		const stack = awsNetworkStack(awsNetworkLayout())
		expect(stack.stackName).toBe(AWS_NETWORK_STACK)
		// Under `fabrika-platform-`, never a prefix Control's role reaches (`fabrika-app-`, `fabrika-ns-`, `fabrika-nh-`).
		expect(stack.stackName.startsWith('fabrika-platform-')).toBe(true)
		const template = JSON.parse(JSON.stringify(stack.template))
		const resources = template.Resources
		expect(resources.Vpc.Properties).toMatchObject({ CidrBlock: '10.80.0.0/16', EnableDnsSupport: true, EnableDnsHostnames: true })
		expect(resources.PublicDefaultRoute).toMatchObject({
			DependsOn: ['InternetGatewayAttachment'],
			Properties: { DestinationCidrBlock: '0.0.0.0/0', GatewayId: { Ref: 'InternetGateway' } },
		})
		const subnets = Object.entries(resources).filter(([, resource]) => JSON.stringify(resource).startsWith('{"Type":"AWS::EC2::Subnet"'))
		expect(subnets.map(([logical]) => logical)).toEqual(['TaskSubnet0', 'TaskSubnet1', 'BalancerSubnet0', 'BalancerSubnet1'])
		expect(resources.TaskSubnet1.Properties).toMatchObject({
			CidrBlock: '10.80.16.0/20',
			AvailabilityZone: { 'Fn::Select': [1, { 'Fn::GetAZs': '' }] },
			MapPublicIpOnLaunch: false,
		})
		expect(resources.BalancerSubnet0.Properties).toMatchObject({ CidrBlock: '10.80.240.0/24', MapPublicIpOnLaunch: false })
		for (const [logical] of subnets) {
			expect(resources[`${logical}Routes`].Properties).toEqual({ SubnetId: { Ref: logical }, RouteTableId: { Ref: 'PublicRouteTable' } })
		}
		const range = (logical: string) => ({ 'Fn::GetAtt': [logical, 'CidrBlock'] })
		expect(template.Outputs).toEqual({
			VpcId: { Value: { Ref: 'Vpc' } },
			VpcCidr: { Value: range('Vpc') },
			TaskSubnetIds: { Value: { 'Fn::Join': [',', [{ Ref: 'TaskSubnet0' }, { Ref: 'TaskSubnet1' }]] } },
			TaskSubnetCidrs: { Value: { 'Fn::Join': [',', [range('TaskSubnet0'), range('TaskSubnet1')]] } },
			BalancerSubnetIds: { Value: { 'Fn::Join': [',', [{ Ref: 'BalancerSubnet0' }, { Ref: 'BalancerSubnet1' }]] } },
			BalancerSubnetCidrs: { Value: { 'Fn::Join': [',', [range('BalancerSubnet0'), range('BalancerSubnet1')]] } },
		})
	})

	test('the outputs are read back, and one of another form is refused', () => {
		expect(awsNetworkOutputs(OUTPUTS)).toEqual({
			vpcId: 'vpc-0123456789abcdef0',
			vpcCidr: '10.80.0.0/16',
			taskSubnetIds: ['subnet-0123456789abcdef0', 'subnet-0123456789abcdef1'],
			taskSubnetCidrs: ['10.80.0.0/20', '10.80.16.0/20'],
			balancerSubnetIds: ['subnet-0123456789abcdef2', 'subnet-0123456789abcdef3'],
			balancerSubnetCidrs: ['10.80.240.0/24', '10.80.241.0/24'],
		})
		expect(() => awsNetworkOutputs({ ...OUTPUTS, VpcId: '' })).toThrow('VpcId')
		expect(() => awsNetworkOutputs({ ...OUTPUTS, TaskSubnetIds: 'subnet-0123456789abcdef0' })).toThrow('TaskSubnetIds')
		expect(() => awsNetworkOutputs({ ...OUTPUTS, BalancerSubnetIds: 'subnet-0123456789abcdef2,sg-0123456789abcdef3' })).toThrow('BalancerSubnetIds')
	})

	test("outputs that name a subnet twice, or as both a task's and a balancer's, or whose ranges overlap, are refused", () => {
		expect(() => awsNetworkOutputs({ ...OUTPUTS, BalancerSubnetIds: 'subnet-0123456789abcdef1,subnet-0123456789abcdef3' })).toThrow('both')
		expect(() => awsNetworkOutputs({ ...OUTPUTS, TaskSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef0' })).toThrow('twice')
		// A task's subnet over a balancer's, as an adopted or drifted network could report it.
		expect(() => awsNetworkOutputs({ ...OUTPUTS, TaskSubnetCidrs: '10.80.0.0/20,10.80.240.0/20' })).toThrow('overlap')
		expect(() => awsNetworkOutputs({ ...OUTPUTS, BalancerSubnetCidrs: '10.80.240.0/24' })).toThrow('overlap')
		expect(() => awsNetworkOutputs({ ...OUTPUTS, VpcCidr: '10.0.0.0/8' })).toThrow('not a /16')
	})

	test("outputs whose ranges are not the layout's never reach Control", () => {
		const layout = awsNetworkLayout()
		// A stack applied from another layout: valid on its own, but not this installation's.
		const other = awsNetworkOutputs({
			...OUTPUTS,
			TaskSubnetCidrs: '10.80.32.0/20,10.80.48.0/20',
			BalancerSubnetCidrs: '10.80.242.0/24,10.80.243.0/24',
		})
		expect(() => awsNetworkEnvironment(layout, other)).toThrow("not the installation's layout")
		expect(() => awsNetworkEnvironment(awsNetworkLayout('10.81.0.0/16'), awsNetworkOutputs(OUTPUTS))).toThrow("not the installation's layout")
	})

	test("the layout's own check refuses a VPC range that is not a /16, however the layout was made", () => {
		const layout = awsNetworkLayout()
		expect(() => checkAwsNetworkLayout({ ...layout, vpcCidr: '10.0.0.0/8' })).toThrow('not a /16')
		expect(() => checkAwsNetworkLayout({ ...layout, vpcCidr: '10.80.0.0/17' })).toThrow('not a /16')
	})

	test("Control's variables: tasks in the task subnets with a public address, and the balancers' ranges its proxies trust", () => {
		const layout = awsNetworkLayout()
		const environment = awsNetworkEnvironment(layout, awsNetworkOutputs(OUTPUTS))
		expect(environment).toEqual({
			FABRIKA_AWS_VPC_ID: 'vpc-0123456789abcdef0',
			FABRIKA_AWS_SUBNETS: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
			FABRIKA_AWS_TASK_PUBLIC_IP: 'true',
			FABRIKA_AWS_VPC_CIDR: '10.80.0.0/16',
			FABRIKA_AWS_BALANCER_SUBNET_CIDRS: '10.80.240.0/24,10.80.241.0/24',
		})
		// The balancers' subnets are not among the tasks', and Control's own check of them passes.
		expect(environment['FABRIKA_AWS_SUBNETS']).not.toContain('subnet-0123456789abcdef2')
		expect(
			checkInstallationBalancer({
				securityGroupId: 'sg-0123456789abcdef1',
				vpcCidr: layout.vpcCidr,
				listenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika/0123456789abcdef/fedcba9876543210',
				installationHosts: ['console.example.com'],
				balancerSubnetCidrs: layout.balancerSubnetCidrs,
			}).balancerSubnetCidrs,
		).toEqual(layout.balancerSubnetCidrs)
	})
})
