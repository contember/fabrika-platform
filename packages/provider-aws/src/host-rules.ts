// A namespace proxy's hosts on the installation's HTTPS listener (the AWS idea's checklist, step 10), as pure functions:
// which hosts the listener may serve for the namespace, each served host's rule priority, and the namespace's hosts
// stack, which holds for each served host its certificate on the listener and a rule forwarding the host to the
// namespace's target group. `proxy-hosts.ts` reads the listener and applies the stack.
//
// - The listener is the installation's, shared by every namespace and by the installation's own routes. A rule is the
//   namespace's own only when it names the one host alone and forwards to the namespace's own target group. A host that
//   any other rule matches (exact or by a wildcard), or that is one of the installation's own hosts, is not served: it
//   is marked a conflict and shown to the operator. So the first namespace to route a host keeps it, and a later one
//   claiming the same host never takes it over; which one is the host's rightful owner is the operator's to decide (the
//   namespace's presentation names the conflict, and the operator removes the domain from the wrong environment).
// - A rule's priority must be one no other rule of the listener holds. Each served host's is chosen against the
//   listener's rules as read, starting from a hash of the host and taking the next free one, and recorded with its
//   certificate, so it stays put; one some other rule has taken since is chosen anew before the stack is rendered.
// - The rule is named by its host and the certificate by its ARN, so a priority chosen anew is an in-place update of the
//   rule (`SetRulePriorities`), never a replacement that would take the certificate off the listener.
//
// UNVERIFIED: the resources' properties, that a rule's priority is unique per listener and at most 50,000, that a
// host-header value's wildcards are `*` and `?` and match case-insensitively, and that removing a `ListenerCertificate`
// takes the certificate off the listener follow the CloudFormation and Elastic Load Balancing references; none was
// checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { type ListenerRule, MAX_RULE_PRIORITY } from './aws/elb'
import type { AwsProxyCertificate } from './codecs'
import type { AwsStack } from './stack'

/** One host the listener serves for the namespace: its certificate and its rule's priority. */
export interface AwsHostRule {
	readonly host: string
	readonly certificateArn: string
	readonly priority: number
}

/** The certificates of `hosts` that the listener can serve: issued ones. */
export function servedCertificates(certificates: readonly AwsProxyCertificate[], hosts: readonly string[]): readonly AwsProxyCertificate[] {
	return certificates.filter((certificate) => certificate.status === 'ISSUED' && hosts.includes(certificate.host))
}

/** The rules the hosts stack renders: its served certificates that hold a priority. */
export function awsHostRules(certificates: readonly AwsProxyCertificate[], hosts: readonly string[]): readonly AwsHostRule[] {
	return servedCertificates(certificates, hosts).flatMap((certificate) =>
		certificate.priority === undefined ? [] : [{ host: certificate.host, certificateArn: certificate.arn, priority: Number(certificate.priority) }]
	)
}

/** Whether the host-header value `pattern` matches `host`: case-insensitive, `*` any run of characters, `?` one. */
export function hostMatches(pattern: string, host: string): boolean {
	const source = [...pattern.toLowerCase()].map((char) => (char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.\\+^$|()[\]{}]/g, '\\$&')))
		.join('')
	return new RegExp(`^${source}$`).test(host.toLowerCase())
}

/** Whether `rule` is the namespace's own rule of `host`: that host alone, forwarding to the namespace's target group alone. */
export function isOwnHostRule(rule: ListenerRule, host: string, targetGroupArn: string): boolean {
	return rule.priority !== 'default' && rule.hosts.length === 1 && rule.hosts[0] === host && rule.targetGroups.length === 1
		&& rule.targetGroups[0] === targetGroupArn
}

/**
 * The hosts of `hosts` the listener must not serve for the namespace: one of the installation's own hosts, or one
 * another rule matches that the listener would serve first. A namespace without a rule of its own for the host defers
 * to any matching rule; one with its own rule defers only to a matching rule of a lower priority number, which the
 * listener evaluates first. So when two namespaces put one host on at the same moment, the one whose rule the listener
 * serves keeps it, whichever of them reconciles first, and the other drops it on its next pass.
 */
export function listenerConflicts(
	hosts: readonly string[],
	rules: readonly ListenerRule[],
	targetGroupArn: string,
	installationHosts: readonly string[],
): ReadonlySet<string> {
	const reserved = new Set(installationHosts.map((host) => host.toLowerCase()))
	return new Set(
		hosts.filter((host) => {
			if (reserved.has(host)) return true
			const own = rules.find((rule) => isOwnHostRule(rule, host, targetGroupArn))
			const ownPriority = own === undefined || own.priority === 'default' ? Number.POSITIVE_INFINITY : own.priority
			return rules.some((rule) =>
				rule.priority !== 'default' && rule !== own && rule.priority < ownPriority && rule.hosts.some((pattern) => hostMatches(pattern, host))
			)
		}),
	)
}

/** FNV-1a over `text`, in hex: where a host's search for a free priority starts, and a resource's name. Not a secret. */
function spread(text: string): number {
	let hash = 0x811c9dc5
	for (const char of new TextEncoder().encode(text)) {
		hash ^= char
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

const nameOf = (text: string): string => spread(text).toString(16).padStart(8, '0')

/**
 * The certificates with each served host's priority chosen: a recorded one is kept while the rule there is the host's
 * own or there is none; otherwise the first free one from the host's hash. A certificate not served holds none.
 */
export function assignHostRulePriorities(
	certificates: readonly AwsProxyCertificate[],
	hosts: readonly string[],
	rules: readonly ListenerRule[],
	targetGroupArn: string,
): readonly AwsProxyCertificate[] {
	const at = new Map<number, ListenerRule>()
	for (const rule of rules) if (rule.priority !== 'default') at.set(rule.priority, rule)
	const ownAt = (priority: number, host: string): boolean => {
		const rule = at.get(priority)
		return rule === undefined || isOwnHostRule(rule, host, targetGroupArn)
	}
	const served = new Set(servedCertificates(certificates, hosts).map((certificate) => certificate.host))
	const claimed = new Set<number>()
	// Recorded priorities first, so a host that keeps its own never loses it to one that is choosing.
	const kept = new Map<string, number>()
	for (const certificate of certificates) {
		if (!served.has(certificate.host) || certificate.priority === undefined) continue
		const priority = Number(certificate.priority)
		if (ownAt(priority, certificate.host) && !claimed.has(priority)) {
			kept.set(certificate.host, priority)
			claimed.add(priority)
		}
	}
	const free = (host: string): number => {
		const start = spread(host) % MAX_RULE_PRIORITY
		for (let step = 0; step < MAX_RULE_PRIORITY; step += 1) {
			const priority = ((start + step) % MAX_RULE_PRIORITY) + 1
			if (!at.has(priority) && !claimed.has(priority)) return priority
		}
		throw new Error("aws: the installation's listener has no free rule priority left")
	}
	return certificates.map((certificate) => {
		const { priority: _recorded, ...rest } = certificate
		if (!served.has(certificate.host)) return rest
		const priority = kept.get(certificate.host) ?? free(certificate.host)
		claimed.add(priority)
		return { ...rest, priority: String(priority) }
	})
}

/**
 * The namespace's hosts stack: for each rule, the certificate on the listener and the host's rule, forwarding to the
 * namespace's target group. A stack holds at least one resource, so a placeholder that creates nothing stays in it.
 */
export function awsHostsStack(
	stackName: string,
	tags: Readonly<Record<string, string>>,
	listenerArn: string,
	targetGroupArn: string,
	rules: readonly AwsHostRule[],
): AwsStack {
	const resources: Record<string, JsonValue> = { Placeholder: { Type: 'AWS::CloudFormation::WaitConditionHandle' } }
	for (const rule of rules) {
		const certificate = `HostCertificate${nameOf(rule.certificateArn)}`
		const hostRule = `HostRule${nameOf(rule.host)}`
		// Two hosts, or two certificates, of one name would be one resource: refused rather than one host lost.
		if (certificate in resources || hostRule in resources) throw new Error(`aws: two hosts of the stack ${stackName} share a resource name`)
		resources[certificate] = {
			Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
			Properties: { ListenerArn: listenerArn, Certificates: [{ CertificateArn: rule.certificateArn }] },
		}
		resources[hostRule] = {
			Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
			// The certificate on the listener first, so the host is never routed before the listener can answer its TLS.
			DependsOn: [certificate],
			Properties: {
				ListenerArn: listenerArn,
				Priority: rule.priority,
				Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [rule.host] } }],
				Actions: [{ Type: 'forward', TargetGroupArn: targetGroupArn }],
			},
		}
	}
	return {
		stackName,
		template: { AWSTemplateFormatVersion: '2010-09-09', Description: `fabrika: the hosts of ${stackName}`, Resources: resources },
		tags,
	}
}
