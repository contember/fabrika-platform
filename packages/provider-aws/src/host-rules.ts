// A namespace proxy's hosts on the installation's HTTPS listener (the AWS idea's checklist, step 10): for every member
// host whose certificate is issued, the namespace's stack holds the certificate on the listener and a host rule that
// forwards the host to the namespace's target group.
//
// - A rule's priority must be one no other rule of the listener holds, and the listener is the installation's, shared by
//   every namespace. Each host's priority is chosen against the listener's rules as read (`describeRules`), starting
//   from a hash of the host and taking the next free one, and recorded with its certificate, so it stays put. A recorded
//   priority some other rule has taken since (another namespace's stack, an operator's rule) is chosen anew before the
//   stack is rendered. Two namespaces choosing the same free priority at once fail one stack update, and its next
//   reconcile chooses again.
// - The resources are named by priority (`HostRule<n>`, `HostCertificate<n>`), so a host that moves is a replacement.
// - A host that left, or whose certificate is not issued, has no rule and no certificate on the listener.
//
// UNVERIFIED: the resources' properties, that a rule's priority is unique per listener and at most 50,000, and that
// removing a `ListenerCertificate` takes the certificate off the listener follow the CloudFormation and Elastic Load
// Balancing references; none was checked against an account.

import type { JsonValue } from '@fabrika/provider-contract'
import { type ListenerRule, MAX_RULE_PRIORITY } from './aws/elb'
import type { AwsProxyCertificate } from './codecs'

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

/** The rules the namespace's stack renders: its served certificates that hold a priority. */
export function awsHostRules(certificates: readonly AwsProxyCertificate[], hosts: readonly string[]): readonly AwsHostRule[] {
	return servedCertificates(certificates, hosts).flatMap((certificate) =>
		certificate.priority === undefined ? [] : [{ host: certificate.host, certificateArn: certificate.arn, priority: Number(certificate.priority) }]
	)
}

/** FNV-1a over `text`: where a host's search for a free priority starts. Not a secret, only a spread. */
function spread(text: string): number {
	let hash = 0x811c9dc5
	for (const char of new TextEncoder().encode(text)) {
		hash ^= char
		hash = Math.imul(hash, 0x01000193) >>> 0
	}
	return hash
}

/**
 * The certificates with each served host's priority chosen: a recorded one is kept while no other rule holds it (the
 * rule there is this host's own, or there is none); otherwise the first free one from the host's hash. A certificate
 * not served holds none.
 */
export function assignHostRulePriorities(
	certificates: readonly AwsProxyCertificate[],
	hosts: readonly string[],
	rules: readonly ListenerRule[],
): readonly AwsProxyCertificate[] {
	const at = new Map<number, ListenerRule>()
	for (const rule of rules) if (rule.priority !== 'default') at.set(rule.priority, rule)
	const ownAt = (priority: number, host: string): boolean => {
		const rule = at.get(priority)
		return rule === undefined || (rule.hosts.length === 1 && rule.hosts[0] === host)
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

/** The listener's resources of `rules`, by priority, for the namespace stack whose target group is `ProxyTargetGroup`. */
export function hostRuleResources(listenerArn: string, rules: readonly AwsHostRule[]): Record<string, JsonValue> {
	const resources: Record<string, JsonValue> = {}
	for (const rule of rules) {
		resources[`HostCertificate${rule.priority}`] = {
			Type: 'AWS::ElasticLoadBalancingV2::ListenerCertificate',
			Properties: { ListenerArn: listenerArn, Certificates: [{ CertificateArn: rule.certificateArn }] },
		}
		resources[`HostRule${rule.priority}`] = {
			Type: 'AWS::ElasticLoadBalancingV2::ListenerRule',
			// The certificate on the listener first, so the host is never routed before the listener can answer its TLS.
			DependsOn: [`HostCertificate${rule.priority}`],
			Properties: {
				ListenerArn: listenerArn,
				Priority: rule.priority,
				Conditions: [{ Field: 'host-header', HostHeaderConfig: { Values: [rule.host] } }],
				Actions: [{ Type: 'forward', TargetGroupArn: { Ref: 'ProxyTargetGroup' } }],
			},
		}
	}
	return resources
}
