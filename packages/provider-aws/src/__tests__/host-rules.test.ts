// The hosts' rules on the installation's listener, as pure functions: which certificates are served, how each served
// host's priority is chosen against the listener's rules and kept, and the resources the namespace stack renders.

import { describe, expect, test } from 'bun:test'
import type { ListenerRule } from '../aws/elb'
import type { AwsProxyCertificate } from '../codecs'
import { assignHostRulePriorities, awsHostRules, hostRuleResources, servedCertificates } from '../host-rules'

const arn = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika/0123456789abcdef/fedcba9876543210'
const rule = (priority: number, hosts: readonly string[]): ListenerRule => ({
	arn: `arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener-rule/app/fabrika/0123456789abcdef/fedcba9876543210/${priority}`,
	priority,
	hosts,
	targetGroups: [],
})
const issued = (host: string, n: number, priority?: number): AwsProxyCertificate => ({
	host,
	arn: arn(n),
	status: 'ISSUED',
	...(priority === undefined ? {} : { priority: String(priority) }),
})

describe('host rules', () => {
	test('only an issued certificate of a current host is served', () => {
		const certificates: AwsProxyCertificate[] = [
			issued('a.example.com', 1),
			{ host: 'b.example.com', arn: arn(2), status: 'PENDING_VALIDATION' },
			issued('gone.example.com', 3),
		]
		expect(servedCertificates(certificates, ['a.example.com', 'b.example.com']).map((certificate) => certificate.host)).toEqual(['a.example.com'])
	})

	test('a served host gets a free priority, the same one on every pass, and keeps it while the rule there is its own', () => {
		const hosts = ['a.example.com', 'b.example.com']
		const first = assignHostRulePriorities([issued('a.example.com', 1), issued('b.example.com', 2)], hosts, [])
		const [a, b] = first
		expect(a?.priority).toMatch(/^[1-9]\d{0,4}$/)
		expect(b?.priority).toMatch(/^[1-9]\d{0,4}$/)
		expect(a?.priority).not.toBe(b?.priority)
		// Chosen again from nothing, the same: the search starts from the host's hash.
		expect(assignHostRulePriorities([issued('a.example.com', 1), issued('b.example.com', 2)], hosts, [])).toEqual(first)
		// Once its rules exist, each keeps its own.
		const rules = first.map((certificate) => rule(Number(certificate.priority), [certificate.host]))
		expect(assignHostRulePriorities(first, hosts, rules)).toEqual(first)
	})

	test('a recorded priority another rule has taken is chosen anew, and never one any rule or host holds', () => {
		const taken = rule(7, ['someone-else.example.com'])
		const [moved] = assignHostRulePriorities([issued('a.example.com', 1, 7)], ['a.example.com'], [taken, rule(8, ['x.example.com'])])
		expect(moved?.priority).not.toBe('7')
		expect(moved?.priority).not.toBe('8')
		// Two hosts that recorded one priority: the first keeps it, the second moves.
		const [one, two] = assignHostRulePriorities([issued('a.example.com', 1, 9), issued('b.example.com', 2, 9)], ['a.example.com', 'b.example.com'], [])
		expect(one?.priority).toBe('9')
		expect(two?.priority).not.toBe('9')
	})

	test('a host no longer served loses its priority', () => {
		const [left, pending] = assignHostRulePriorities(
			[issued('gone.example.com', 1, 5), { host: 'b.example.com', arn: arn(2), status: 'PENDING_VALIDATION', priority: '6' }],
			['b.example.com'],
			[],
		)
		expect(left).toEqual({ host: 'gone.example.com', arn: arn(1), status: 'ISSUED' })
		expect(pending?.priority).toBeUndefined()
	})

	test("the stack's resources: the certificate on the listener, then the host's rule forwarding to the namespace's target group", () => {
		const rules = awsHostRules([issued('a.example.com', 1, 42), issued('b.example.com', 2)], ['a.example.com', 'b.example.com'])
		// A served host without a priority yet renders nothing.
		expect(rules).toEqual([{ host: 'a.example.com', certificateArn: arn(1), priority: 42 }])
		expect(hostRuleResources(LISTENER, rules)).toEqual({
			HostCertificate42: {
				Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
				Properties: { ListenerArn: LISTENER, Certificates: [{ CertificateArn: arn(1) }] },
			},
			HostRule42: {
				Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
				DependsOn: ['HostCertificate42'],
				Properties: {
					ListenerArn: LISTENER,
					Priority: 42,
					Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['a.example.com'] } }],
					Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'ProxyTargetGroup' } }],
				},
			},
		})
	})
})
