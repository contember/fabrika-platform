/**
 * The environment NAME, and the one rule that keeps it honest.
 *
 * `local` is not a label. It is the switch every Access-plane bypass is gated on — IAM's
 * `localDevLogin` (`iam/src/services.ts`), its ephemeral signing key (`iam/src/signing.ts`) and its
 * credential-less caller path (`iam/src/auth.ts`) all fire on exactly this string. A live installation
 * carrying it is one added branch away from turning them on, which is what `fabrika-test` was measured
 * doing on 2026-08-05 (backlog 59). So a composition that can SEE it is not local REFUSES the name,
 * on the same reasoning as `readProxyEnv` and `buildOidc`: refusing to boot beats booting
 * misconfigured.
 *
 * What "can see it" means is the whole design, and shared code does not go looking for a signal. The
 * COMPOSITION ROOT states the fact, the way it names the client-address header
 * (`iam/src/client-address.ts`), and the fact it states is the PUBLIC ORIGIN this service serves on.
 * That value is the one thing here that cannot be wrong quietly: it is the `iss` of every minted
 * token, the host a `__Host-` cookie belongs to, and the address a browser is sent back to. A service
 * answering on a public name is not a laptop, whatever `ENVIRONMENT` says — and no local composition
 * in this repository has one (`local-stack/compose.yaml` serves `*.fabrika.localhost`, the Cloudflare
 * local build serves `http://localhost:18191`).
 *
 * Two non-answers are supported and are never a guess: naming NO origin means this composition cannot
 * see its own public address, and an origin that is not a parseable absolute URL is not evidence
 * either — a typo there already breaks sign-in, and turning it into a second, different failure buys
 * nothing.
 */

/** The environment name every bypass is gated on. Compared literally; there is no other spelling. */
export const LOCAL_ENVIRONMENT = 'local'

/**
 * The ONE name an IAM issuer travels under, from the platform's own configuration to the application
 * that verifies tokens against it ([ADR-0035](../../../docs/decisions/0035-the-platform-owns-the-application-iam-issuer.md)).
 *
 * PLATFORM-OWNED, which is why it is a constant here rather than a string each reader spells. It is the
 * `iss` of every token, it is identical for every application on an installation, and the control plane
 * is the only thing that knows it — so a deploy delivers it in `managedEnvironment` and an application
 * that declares it for itself is refused rather than quietly pointed somewhere else.
 *
 * It lives in this package because everything that reads or writes it — `@fabrika/auth`, both proxies,
 * `@fabrika/provider-contract` and the control plane — already depends on `@fabrika/auth-core`, and
 * `@fabrika/auth-core` depends on nothing.
 */
export const FABRIKA_IAM_ISSUER = 'FABRIKA_IAM_ISSUER'

export class EnvironmentNameError extends Error {
	constructor(publicOrigin: string) {
		super(
			`ENVIRONMENT=${LOCAL_ENVIRONMENT} is refused: this service serves ${publicOrigin}, which is not a loopback address. `
				+ 'Name the environment this installation actually is.',
		)
		this.name = 'EnvironmentNameError'
	}
}

/**
 * Loopback per RFC 6761 §6.3 — `localhost` and every name under `.localhost` always resolve to the
 * loopback interface — plus the literal loopback addresses. Deliberately nothing else: a LAN address
 * or an internal DNS name is still a name another machine reaches this service at.
 */
export function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase()
	if (host === 'localhost' || host.endsWith('.localhost')) {
		return true
	}
	// `URL.hostname` keeps the brackets on an IPv6 literal; accept both spellings.
	if (host === '::1' || host === '[::1]') {
		return true
	}
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/**
 * Validate a composition's declared environment name against the public origin it serves on, and
 * return the name. Throws `EnvironmentNameError` only for the one contradiction it can prove.
 *
 * @param declared the raw `ENVIRONMENT` value
 * @param publicOrigin this composition's own public origin, or `undefined` when it has none to state
 */
export function readEnvironmentName(declared: string, publicOrigin: string | undefined): string {
	if (declared !== LOCAL_ENVIRONMENT || publicOrigin === undefined || publicOrigin.trim() === '') {
		return declared
	}
	let hostname: string
	try {
		hostname = new URL(publicOrigin).hostname
	} catch {
		return declared
	}
	if (hostname === '' || isLoopbackHost(hostname)) {
		return declared
	}
	throw new EnvironmentNameError(publicOrigin)
}
