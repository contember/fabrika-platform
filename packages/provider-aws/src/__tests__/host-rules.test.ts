// The hosts' rules on the installation's listener, as pure functions: a host-header value's match, which rule is a
// namespace's own (its host alone, to its own target group), which hosts conflict with another rule or the
// installation's own, how a served host's priority is chosen and kept, and the hosts stack rendered.

import { describe, expect, test } from 'bun:test'
import type { ListenerRule } from '../aws/elb'
import type { AwsProxyCertificate } from '../codecs'
import {
	assignHostRulePriorities,
	awsHostRules,
	awsHostsStack,
	hostMatches,
	isOwnHostRule,
	listenerConflicts,
	servedCertificates,
} from '../host-rules'

const arn = (n: number) => `arn:aws:acm:eu-central-1:123456789012:certificate/00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const LISTENER = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener/app/fabrika/0123456789abcdef/fedcba9876543210'
const OURS = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Proxy-1A2B3C4D/0123456789abcdef'
const THEIRS = 'arn:aws:elasticloadbalancing:eu-central-1:123456789012:targetgroup/fabri-Proxy-5E6F7A8B/fedcba9876543210'
const rule = (priority: number | 'default', hosts: readonly string[], targetGroups: readonly string[] = [OURS]): ListenerRule => ({
	arn: `arn:aws:elasticloadbalancing:eu-central-1:123456789012:listener-rule/app/fabrika/0123456789abcdef/fedcba9876543210/${priority}`,
	priority,
	hosts,
	targetGroups,
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

	test('a host-header value matches case-insensitively, `*` a run of characters and `?` one; nothing else is a wildcard', () => {
		expect(hostMatches('notes.example.com', 'notes.example.com')).toBe(true)
		expect(hostMatches('Notes.Example.com', 'notes.example.com')).toBe(true)
		expect(hostMatches('*.example.com', 'notes.example.com')).toBe(true)
		expect(hostMatches('*.example.com', 'example.com')).toBe(false)
		expect(hostMatches('note?.example.com', 'notes.example.com')).toBe(true)
		expect(hostMatches('notes.example.com', 'notesXexample.com')).toBe(false)
		expect(hostMatches('*', 'anything.example.com')).toBe(true)
	})

	test("a rule is the namespace's own only when it names the host alone and forwards to the namespace's target group alone", () => {
		expect(isOwnHostRule(rule(7, ['a.example.com']), 'a.example.com', OURS)).toBe(true)
		expect(isOwnHostRule(rule(7, ['a.example.com'], [THEIRS]), 'a.example.com', OURS)).toBe(false)
		expect(isOwnHostRule(rule(7, ['a.example.com'], [OURS, THEIRS]), 'a.example.com', OURS)).toBe(false)
		expect(isOwnHostRule(rule(7, ['a.example.com', 'b.example.com']), 'a.example.com', OURS)).toBe(false)
		expect(isOwnHostRule(rule('default', ['a.example.com']), 'a.example.com', OURS)).toBe(false)
	})

	test("a host another namespace's rule, a wildcard rule or the installation already holds is a conflict; its own rule is none", () => {
		const hosts = ['a.example.com', 'b.example.com', 'c.other.org', 'console.example.com', 'd.example.com']
		const rules = [
			rule(5, ['a.example.com']),
			// Another namespace routed b first.
			rule(9, ['b.example.com'], [THEIRS]),
			// An operator's wildcard on other.org.
			rule(11, ['*.other.org'], [THEIRS]),
			// The listener's default action never makes a conflict of its own.
			rule('default', [], [THEIRS]),
		]
		expect([...listenerConflicts(hosts, rules, OURS, ['console.example.com'])].sort()).toEqual(['b.example.com', 'c.other.org', 'console.example.com'])
	})

	test('two namespaces that put one host on at once: the rule the listener serves first keeps it, whoever looks first', () => {
		const both = [rule(5, ['a.example.com'], [OURS]), rule(9, ['a.example.com'], [THEIRS])]
		// Ours is evaluated first (5 before 9): we keep it, and they see a conflict.
		expect(listenerConflicts(['a.example.com'], both, OURS, []).size).toBe(0)
		expect([...listenerConflicts(['a.example.com'], both, THEIRS, [])]).toEqual(['a.example.com'])
		// Turned around, they keep it.
		const turned = [rule(9, ['a.example.com'], [OURS]), rule(5, ['a.example.com'], [THEIRS])]
		expect([...listenerConflicts(['a.example.com'], turned, OURS, [])]).toEqual(['a.example.com'])
		expect(listenerConflicts(['a.example.com'], turned, THEIRS, []).size).toBe(0)
	})

	test('a served host gets a free priority, the same one on every pass, and keeps it while the rule there is its own', () => {
		const hosts = ['a.example.com', 'b.example.com']
		const first = assignHostRulePriorities([issued('a.example.com', 1), issued('b.example.com', 2)], hosts, [], OURS)
		const [a, b] = first
		expect(a?.priority).toMatch(/^[1-9]\d{0,4}$/)
		expect(b?.priority).toMatch(/^[1-9]\d{0,4}$/)
		expect(a?.priority).not.toBe(b?.priority)
		expect(assignHostRulePriorities([issued('a.example.com', 1), issued('b.example.com', 2)], hosts, [], OURS)).toEqual(first)
		const rules = first.map((certificate) => rule(Number(certificate.priority), [certificate.host]))
		expect(assignHostRulePriorities(first, hosts, rules, OURS)).toEqual(first)
	})

	test("a recorded priority another namespace's rule of the same host holds is not kept: the target group tells them apart", () => {
		// Both namespaces chose the same priority for one host; the other's rule won.
		const [moved] = assignHostRulePriorities([issued('a.example.com', 1, 7)], ['a.example.com'], [rule(7, ['a.example.com'], [THEIRS])], OURS)
		expect(moved?.priority).not.toBe('7')
		const [taken] = assignHostRulePriorities([issued('a.example.com', 1, 7)], ['a.example.com'], [
			rule(7, ['x.example.com']),
			rule(8, ['y.example.com']),
		], OURS)
		expect(taken?.priority).not.toBe('7')
		expect(taken?.priority).not.toBe('8')
		const [one, two] = assignHostRulePriorities(
			[issued('a.example.com', 1, 9), issued('b.example.com', 2, 9)],
			['a.example.com', 'b.example.com'],
			[],
			OURS,
		)
		expect(one?.priority).toBe('9')
		expect(two?.priority).not.toBe('9')
	})

	test('a host no longer served loses its priority', () => {
		const [left, pending] = assignHostRulePriorities(
			[issued('gone.example.com', 1, 5), { host: 'b.example.com', arn: arn(2), status: 'PENDING_VALIDATION', priority: '6' }],
			['b.example.com'],
			[],
			OURS,
		)
		expect(left).toEqual({ host: 'gone.example.com', arn: arn(1), status: 'ISSUED' })
		expect(pending?.priority).toBeUndefined()
	})

	test('the hosts stack: a placeholder, and per host its certificate on the listener and its rule, named by certificate and host', () => {
		const rules = awsHostRules([issued('a.example.com', 1, 42), issued('b.example.com', 2)], ['a.example.com', 'b.example.com'])
		// A served host without a priority yet renders nothing.
		expect(rules).toEqual([{ host: 'a.example.com', certificateArn: arn(1), priority: 42 }])
		const stack = awsHostsStack('fabrika-nh-6-shared-prod', { 'fabrika:namespace': 'shared' }, LISTENER, OURS, rules)
		expect(stack.stackName).toBe('fabrika-nh-6-shared-prod')
		expect(stack.tags).toEqual({ 'fabrika:namespace': 'shared' })
		const template = JSON.parse(JSON.stringify(stack.template))
		const names = Object.keys(template.Resources)
		expect(names[0]).toBe('Placeholder')
		const certificate = names.find((name) => name.startsWith('HostCertificate')) ?? ''
		const hostRule = names.find((name) => name.startsWith('HostRule')) ?? ''
		expect(template.Resources[certificate]).toEqual({
			Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
			Properties: { ListenerArn: LISTENER, Certificates: [{ CertificateArn: arn(1) }] },
		})
		expect(template.Resources[hostRule]).toEqual({
			Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
			DependsOn: [certificate],
			Properties: {
				ListenerArn: LISTENER,
				Priority: 42,
				Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: ['a.example.com'] } }],
				Actions: [{ Type: 'forward', TargetGroupArn: OURS }],
			},
		})
		// A priority chosen anew keeps both names: an in-place update, never a replacement.
		const moved = awsHostsStack('fabrika-nh-6-shared-prod', {}, LISTENER, OURS, [{
			...rules[0],
			host: 'a.example.com',
			certificateArn: arn(1),
			priority: 43,
		}])
		expect(Object.keys(JSON.parse(JSON.stringify(moved.template)).Resources)).toEqual(names)
		// No host: the placeholder alone.
		expect(Object.keys(JSON.parse(JSON.stringify(awsHostsStack('s', {}, LISTENER, OURS, []).template)).Resources)).toEqual(['Placeholder'])
	})
})
