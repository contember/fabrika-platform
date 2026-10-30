// The runner Worker's caller check. A Cloudflare service binding is NOT a capability: any Worker deployed
// into the same account can declare `<env>-vozka-runner` and invoke these RPC methods, so "only the
// control plane holds the binding" authenticates nothing. Every job carries the shared secret the
// control plane holds and the Worker verifies it BEFORE it addresses a container or touches R2.

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

const INSTANCE_NAME_CONTEXT = 'vozka-runner/container-instance/v1:'

/**
 * The name a run's `RunnerContainer` is addressed by: HMAC-SHA256(FABRIKA_RUNNER_KEY, runId) as hex. Any
 * Worker on the account can bind the class and address an instance by name, so a name derived from the
 * run id alone would hand it a real run's container. An unset key denies, and the key never reaches the name.
 */
export const runnerInstanceName = async (configured: string | undefined, runId: string): Promise<string> => {
	if (configured === undefined || configured === '') {
		throw new Error('runner: FABRIKA_RUNNER_KEY is not configured')
	}
	const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(configured), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
	const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${INSTANCE_NAME_CONTEXT}${runId}`))
	return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The slice of the `RUNNER` namespace that turns an instance name into its id. */
export type RunnerInstanceIds = Pick<DurableObjectNamespace, 'idFromName'>

/** The id of the instance keyed to `runId` — the only instance that may act for that run. */
export const runnerInstanceId = async (namespace: RunnerInstanceIds, configured: string | undefined, runId: string): Promise<DurableObjectId> =>
	namespace.idFromName(await runnerInstanceName(configured, runId))

/**
 * Refuse to act for `runId` inside any instance but the one its keyed name addresses. An instance another
 * Worker started under a name of its own could otherwise persist a real run's terminal status — and with
 * it an IAM reconcile Control would apply.
 */
export const assertRunnerInstance = async (
	namespace: RunnerInstanceIds,
	self: DurableObjectId,
	configured: string | undefined,
	runId: string,
): Promise<void> => {
	if (!self.equals(await runnerInstanceId(namespace, configured, runId))) {
		throw new Error('runner: this instance does not belong to that run')
	}
}
