const IPV4_LITERAL = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
const PRIVATE_SUFFIXES = ['.localhost', '.local', '.internal']

/**
 * Validate the syntax of a public webhook target. DNS resolution remains the egress layer's job.
 */
export function isValidWebhookTarget(target: string): boolean {
	let url: URL
	try {
		url = new URL(target)
	} catch {
		return false
	}
	if (
		url.protocol !== 'https:'
		|| url.username !== ''
		|| url.password !== ''
		|| url.hash !== ''
	) {
		return false
	}

	const hostname = url.hostname.toLowerCase().replace(/\.+$/, '')
	if (
		hostname === ''
		|| hostname === 'localhost'
		|| PRIVATE_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
		|| isIpLiteral(hostname)
	) {
		return false
	}
	const labels = hostname.split('.')
	return labels.length > 1 && labels.every((label) => DNS_LABEL.test(label))
}

function isIpLiteral(hostname: string): boolean {
	return hostname.includes(':') || IPV4_LITERAL.test(hostname)
}
