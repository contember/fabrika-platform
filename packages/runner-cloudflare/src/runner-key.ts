// vozka-runner's caller check. A Cloudflare service binding is NOT a capability: any Worker deployed
// into the same account can declare `<env>-vozka-runner` and invoke these RPC methods, so "only the
// control plane holds the binding" authenticates nothing. Every job carries the shared secret the
// control plane holds and the Worker verifies it BEFORE it addresses a container or touches D1.

/** SHA-256 hex of a value. Hashing first keeps the comparison fixed-width, so neither length nor prefix leaks. */
const digestHex = async (value: string): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time equality for two SHA-256 hex digests — no per-character timing signal. */
const timingSafeEqualHex = (a: string, b: string): boolean => {
	if (a.length !== b.length) {
		return false
	}
	let diff = 0
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
	}
	return diff === 0
}

/**
 * Refuse every caller that does not present the configured runner key. It THROWS rather than returning
 * a boolean, so a call site that forgets to check cannot read as "allowed". An unset key denies every
 * call (fail closed); a wrong key is refused with a message that names nothing.
 */
export const assertRunnerKey = async (configured: string | undefined, presented: string): Promise<void> => {
	if (configured === undefined || configured === '') {
		throw new Error('runner: FABRIKA_RUNNER_KEY is not configured')
	}
	if (presented === '' || !timingSafeEqualHex(await digestHex(presented), await digestHex(configured))) {
		throw new Error('runner: unauthorized')
	}
}
