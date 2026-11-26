// A namespace proxy's certificates (the AWS idea's checklist, step 10): one public ACM certificate per member host,
// validated by a DNS record the operator adds, which the installation's HTTPS listener will serve the host with.
//
// - Requested on every republish and reconcile for a routed member's host that has none, and recorded once ACM answered
//   (ADR-0044). The idempotency token is derived from the namespace, the host and the certificate it replaces, so a lost
//   answer repeated within ACM's hour answers the same certificate, and a replacement is a new request.
// - Every recorded certificate is read again: its status and the validation record, which the namespace's presentation
//   shows the operator, who keeps it in place (ACM's renewal uses it).
// - Nothing waits for a certificate and nothing fails on one: validation waits on the operator's DNS, which can take
//   days, and a namespace that is not ready refuses deploys. The operator adds the record, then reconciles the namespace.
// - One ACM no longer knows (deleted out of band) is requested anew on the same pass. One that failed or timed out
//   stays recorded and shown: requesting another would loop on what made it fail (a CAA record, DNS never added); the
//   operator deletes it in ACM, and the next pass requests a new one.
// - Nothing here tags or deletes a certificate (`aws/acm.ts`). A host that left keeps its entry, marked `departed`,
//   which the presentation hands to the operator to delete; the pass after the delete forgets it.
// - At most `AWS_MAX_PROXY_CERTIFICATES` entries, departed ones counted (they hold a place on the listener until
//   deleted): a host over it gets no certificate this pass, and the rest of the pass runs as ever.
//
// UNVERIFIED: that ACM answers the same certificate for a repeated token within an hour, and its validation records,
// follow ACM's documentation; neither was checked against an account.

import type { ProviderDeploymentNamespace, ProviderNamespaceEvents, ProviderNamespaceMember } from '@fabrika/provider-contract'
import type { AcmClient, Certificate } from './aws/acm'
import { AWS_MAX_PROXY_CERTIFICATES, type AwsAppTarget, type AwsNamespaceTarget, type AwsProxyCertificate } from './codecs'
import { awsNamespaceTargetEnvelope, type AwsProxySource, checkNamespaceTarget } from './namespace'
import { sha256Hex } from './proxy-attempt'
import { awsNamespaceMemberHosts } from './proxy-manifest'

export interface AwsProxyCertificateClients {
	readonly acm: Pick<AcmClient, 'requestCertificate' | 'describeCertificate'>
}

export interface AwsProxyCertificatesInput {
	readonly namespace: ProviderDeploymentNamespace
	readonly members: readonly ProviderNamespaceMember[]
	readonly installation: AwsAppTarget
	readonly proxySource: AwsProxySource
	readonly clients: AwsProxyCertificateClients
	readonly events: ProviderNamespaceEvents
	readonly signal: AbortSignal
}

/** The routed hosts of `members`, sorted. */
export function awsProxyHosts(members: readonly ProviderNamespaceMember[]): readonly string[] {
	return [...new Set(members.flatMap((member) => awsNamespaceMemberHosts(member)))].sort()
}

/** The idempotency token of a request for `host`: ACM takes word characters, at most 32. */
async function requestToken(namespace: ProviderDeploymentNamespace, host: string, replaced: string | undefined): Promise<string> {
	return (await sha256Hex(`${namespace.id}\n${namespace.env}\n${host}\n${replaced ?? ''}`)).slice(0, 32)
}

/** A certificate as the namespace records it. */
function recordOf(certificate: Certificate): AwsProxyCertificate {
	return {
		host: certificate.host,
		arn: certificate.arn,
		status: certificate.status,
		...(certificate.validation === null ? {} : { validationName: certificate.validation.name, validationValue: certificate.validation.value }),
	}
}

/** Requests the certificates the namespace's hosts lack and reads the recorded ones again; answers the namespace as recorded. */
export async function ensureAwsProxyCertificates(input: AwsProxyCertificatesInput): Promise<ProviderDeploymentNamespace> {
	const { clients, signal } = input
	let namespace = input.namespace
	let stored = checkNamespaceTarget(namespace, input.installation, input.proxySource)
	const hosts = awsProxyHosts(input.members)
	const record = async (certificates: readonly AwsProxyCertificate[]): Promise<void> => {
		const { proxyCertificates: _previous, ...rest } = stored
		const next: AwsNamespaceTarget = certificates.length === 0 ? rest : { ...rest, proxyCertificates: certificates }
		stored = next
		namespace = { ...namespace, target: awsNamespaceTargetEnvelope(next) }
		await input.events.checkpoint(namespace)
	}
	// One host at a time, each recorded as it changes: a crash keeps every certificate ACM answered.
	const replace = async (host: string, certificate: AwsProxyCertificate | null): Promise<void> => {
		const others = (stored.proxyCertificates ?? []).filter((entry) => entry.host !== host)
		await record([...others, ...(certificate === null ? [] : [certificate])].sort((a, b) => a.host.localeCompare(b.host)))
	}
	const changed = (next: AwsProxyCertificate, current: AwsProxyCertificate): boolean => JSON.stringify(next) !== JSON.stringify(current)

	// The hosts that left: read again, so one the operator deleted is forgotten and frees its place.
	for (const current of [...(stored.proxyCertificates ?? [])]) {
		if (hosts.includes(current.host)) continue
		const read = await clients.acm.describeCertificate(current.arn, signal)
		if (read !== null && read.host !== current.host) throw new Error(`aws: the certificate recorded for ${current.host} is another host's`)
		const next: AwsProxyCertificate | null = read === null ? null : { ...recordOf(read), departed: true }
		if (next === null || changed(next, current)) await replace(current.host, next)
	}
	for (const host of hosts) {
		const current = (stored.proxyCertificates ?? []).find((entry) => entry.host === host)
		if (current !== undefined) {
			const read = await clients.acm.describeCertificate(current.arn, signal)
			if (read !== null && read.host !== host) throw new Error(`aws: the certificate recorded for ${host} is another host's`)
			if (read === null) {
				// Gone out of band: requested anew under a token of its own, and the entry replaced only once ACM answered, so a
				// crash in between asks again with the same token rather than with the first one, which could answer the gone one.
				await request(host, current.arn)
			} else if (changed(recordOf(read), current)) {
				// A host that came back is current again: its entry loses the departed mark.
				await replace(host, recordOf(read))
			}
		} else if ((stored.proxyCertificates ?? []).length < AWS_MAX_PROXY_CERTIFICATES) {
			await request(host, undefined)
		}
		// Over the cap, the host waits for a place; the presentation says so.
	}
	return namespace

	async function request(host: string, replaced: string | undefined): Promise<void> {
		const arn = await clients.acm.requestCertificate({ host, token: await requestToken(namespace, host, replaced) }, signal)
		await replace(host, { host, arn, status: 'PENDING_VALIDATION' })
	}
}
