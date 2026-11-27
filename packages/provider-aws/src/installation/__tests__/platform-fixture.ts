// One installation as the platform's stacks answer it, which the run's tests and the parameters' tests share: the
// operator's plan, and each stack's outputs in the forms AWS gives them.

import type { AwsPlatformPlan, AwsPlatformState } from '../apply'
import { AWS_BALANCERS_STACK, awsBalancersOutputs } from '../balancers'
import { AWS_DATABASE_STACK, awsDatabaseOutputs } from '../database'
import { AWS_NETWORK_STACKS, awsNetworkOutputs } from '../network'
import { AWS_RUNTIME_STACK, awsRuntimeOutputs } from '../runtime'
import { AWS_SETUP_STACK } from '../services'

const certificate = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

export const PLAN: AwsPlatformPlan = {
	accountId: '123456789012',
	region: 'eu-central-1',
	vpcCidrs: { apps: '10.80.0.0/16', platform: '10.81.0.0/16' },
	hosts: { iam: 'iam.example.com', control: 'control.example.com', operations: 'operations.example.com' },
	certificates: { iam: certificate(1), control: certificate(2), operations: certificate(3) },
	appsDefault: { host: 'apps.example.com', certificate: certificate(4) },
}

export const SETUP_DEFINITION = 'arn:aws:ecs:eu-central-1:123456789012:task-definition/fabrika_platform_setup:1'

/** Each stack's outputs by its name. */
export const OUTPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
	[AWS_NETWORK_STACKS.apps]: {
		VpcId: 'vpc-0123456789abcdef0',
		VpcCidr: '10.80.0.0/16',
		TaskSubnetIds: 'subnet-0123456789abcdef0,subnet-0123456789abcdef1',
		TaskSubnetCidrs: '10.80.0.0/20,10.80.16.0/20',
		BalancerSubnetIds: 'subnet-0123456789abcdef2,subnet-0123456789abcdef3',
		BalancerSubnetCidrs: '10.80.240.0/24,10.80.241.0/24',
	},
	[AWS_NETWORK_STACKS.platform]: {
		VpcId: 'vpc-0123456789abcdef9',
		VpcCidr: '10.81.0.0/16',
		TaskSubnetIds: 'subnet-0123456789abcdef4,subnet-0123456789abcdef5',
		TaskSubnetCidrs: '10.81.0.0/20,10.81.16.0/20',
		BalancerSubnetIds: 'subnet-0123456789abcdef6,subnet-0123456789abcdef7',
		BalancerSubnetCidrs: '10.81.240.0/24,10.81.241.0/24',
	},
	[AWS_BALANCERS_STACK]: {
		AppsBalancerGroupId: 'sg-0123456789abcdef1',
		AppsHttpsListenerArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika-apps/0123456789abcdef/fedcba9876543210',
		AppsBalancerDnsName: 'fabrika-apps-1234567890.eu-central-1.elb.amazonaws.com',
		PlatformBalancerGroupId: 'sg-0123456789abcdef2',
		PlatformProxyTargetGroupArn: 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Platf-1A2B3C4D/0123456789abcdef',
		PlatformBalancerDnsName: 'fabrika-platform-1234567890.eu-central-1.elb.amazonaws.com',
	},
	[AWS_DATABASE_STACK]: {
		DatabaseHost: 'fabrika-database-abcdefgh.c1a2b3c4d5e6.eu-central-1.rds.amazonaws.com',
		DatabasePort: '5432',
		DatabaseClientGroupId: 'sg-0123456789abcdefa',
	},
	[AWS_RUNTIME_STACK]: {
		NamespaceArn: 'arn:aws:servicediscovery:eu-central-1:123456789012:namespace/ns-0123456789abcdef',
		IamGroupId: 'sg-0123456789abcdef3',
		ControlGroupId: 'sg-0123456789abcdef4',
		OperationsGroupId: 'sg-0123456789abcdef5',
		ProxyGroupId: 'sg-0123456789abcdef6',
		SetupGroupId: 'sg-0123456789abcdef7',
	},
	[AWS_SETUP_STACK]: { SetupTaskDefinitionArn: SETUP_DEFINITION },
}

/** The run's state once the stacks before the images answered. */
export function platformState(): AwsPlatformState {
	const outputs = (name: string) => OUTPUTS[name] ?? {}
	return {
		plan: PLAN,
		apps: awsNetworkOutputs(outputs(AWS_NETWORK_STACKS.apps)),
		platform: awsNetworkOutputs(outputs(AWS_NETWORK_STACKS.platform)),
		balancers: awsBalancersOutputs(outputs(AWS_BALANCERS_STACK)),
		database: awsDatabaseOutputs(outputs(AWS_DATABASE_STACK)),
		runtime: awsRuntimeOutputs(outputs(AWS_RUNTIME_STACK)),
	}
}
