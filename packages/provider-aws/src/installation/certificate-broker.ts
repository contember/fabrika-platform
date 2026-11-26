// The certificate broker (the plan's step 11 decision on the platform's certificates, 2026-11-26): the one principal that
// attaches certificates to the applications' listener. Elastic Load Balancing scopes `AddListenerCertificates` by the
// listener alone (no condition key names the certificate, and attaching one needs no ACM permission), so Control's
// role, which a namespace's hosts stack is applied with, holds neither listener certificate action. A hosts stack names
// its certificates as custom resources of this function (`host-rules.ts`), which Control's role may only invoke:
//
// - it attaches a certificate to the applications' listener alone (its own configuration, never the request's), and
//   only one none of whose names (exact or by a wildcard) is an installation host: IAM's, Control's, Operations', the
//   applications' default certificate's;
// - it removes what it attached when the stack drops it;
// - it answers CloudFormation through the presigned response URL, a failure with its reason, never a credential.
//
// Its configuration (the listener, the installation's hosts) is its environment, written by the access stack; Control
// is denied every Lambda action on it but invoking it, and every IAM action on its role (`access.ts`).
//
// The source is plain CommonJS for Lambda's Node.js runtime, inline in the template (at most 4,096 characters), with
// the AWS SDK the runtime carries. `make` takes its calls as parameters, so the tests run it against fakes.
//
// UNVERIFIED: that CloudFormation invokes a custom resource's function with the stack caller's credentials (so Control's
// role needs `lambda:InvokeFunction`), the custom resource protocol's fields, and that the runtime carries the SDK's
// Elastic Load Balancing V2 and ACM clients follow AWS's documentation; none was checked against an account.

/** The broker's function and its role, under the platform's names, out of Control's reach. */
export const AWS_CERTIFICATE_BROKER = 'fabrika-certificate-broker'
/** The runtime the source is written for. */
export const AWS_CERTIFICATE_BROKER_RUNTIME = 'nodejs22.x'
/** The most characters CloudFormation takes as a function's inline source. */
export const AWS_MAX_INLINE_SOURCE = 4096

/** The broker's ARN in the account and region of `listenerArn`, which a hosts stack's custom resources name. */
export function awsCertificateBrokerArn(listenerArn: string): string {
	const [, partition, , region, accountId] = /^arn:([^:]+):([^:]+):([^:]+):(\d{12}):/.exec(listenerArn) ?? []
	if (partition === undefined || region === undefined || accountId === undefined) throw new Error('aws: the listener ARN names no account and region')
	return `arn:${partition}:lambda:${region}:${accountId}:function:${AWS_CERTIFICATE_BROKER}`
}

/** The broker's source: `index.handler` over the SDK, `make` over any calls. */
export const AWS_CERTIFICATE_BROKER_SOURCE = String.raw`'use strict'
const reserved = () => (process.env.RESERVED_HOSTS || '').split(',').filter(Boolean)
// Whether a certificate name covers a host: the host itself, or a wildcard of its parent.
const covers = (name, host) => {
	const n = String(name).toLowerCase()
	return n === host || (n.startsWith('*.') && host.slice(host.indexOf('.') + 1) === n.slice(2))
}
exports.covers = covers
exports.make = (deps) => async (event) => {
	const props = event.ResourceProperties || {}
	const listener = process.env.LISTENER_ARN
	let status = 'SUCCESS'
	let reason = ''
	let id = event.PhysicalResourceId || 'none'
	try {
		if (event.RequestType === 'Delete') {
			const [l, c] = id.split('|')
			if (l === listener && c) await deps.remove(listener, c)
		} else {
			if (props.ListenerArn !== listener) throw new Error('not the applications listener')
			const names = await deps.names(props.CertificateArn)
			if (names.length === 0) throw new Error('the certificate names no host')
			const hit = reserved().find((host) => names.some((name) => covers(name, host)))
			if (hit) throw new Error('the certificate names an installation host: ' + hit)
			await deps.add(listener, props.CertificateArn)
			id = listener + '|' + props.CertificateArn
		}
	} catch (error) {
		status = 'FAILED'
		reason = String((error && error.message) || error).slice(0, 200)
	}
	await deps.respond(event.ResponseURL, {
		Status: status,
		Reason: reason,
		PhysicalResourceId: id,
		StackId: event.StackId,
		RequestId: event.RequestId,
		LogicalResourceId: event.LogicalResourceId,
	})
}
exports.handler = (event) => {
	const elbv2 = require('@aws-sdk/client-elastic-load-balancing-v2')
	const acm = require('@aws-sdk/client-acm')
	const elb = new elbv2.ElasticLoadBalancingV2Client({})
	const certificates = new acm.ACMClient({})
	const one = (l, c) => ({ ListenerArn: l, Certificates: [{ CertificateArn: c }] })
	return exports.make({
		names: async (arn) => {
			const c = (await certificates.send(new acm.DescribeCertificateCommand({ CertificateArn: arn }))).Certificate || {}
			return [c.DomainName, ...(c.SubjectAlternativeNames || [])].filter(Boolean)
		},
		add: (l, c) => elb.send(new elbv2.AddListenerCertificatesCommand(one(l, c))),
		remove: async (l, c) => {
			try {
				await elb.send(new elbv2.RemoveListenerCertificatesCommand(one(l, c)))
			} catch (error) {
				if (error.name !== 'ListenerNotFoundException' && error.name !== 'CertificateNotFoundException') throw error
			}
		},
		respond: (url, body) => fetch(url, { method: 'PUT', headers: { 'content-type': '' }, body: JSON.stringify(body) }),
	})(event)
}
`
