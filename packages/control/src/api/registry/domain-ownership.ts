// Who may name a domain. A domain routes one application environment of the whole installation, whatever its namespace
// or provider, and the installation's own hosts (IAM, the console and Control) are no application's: a deploy to a held
// domain would hand the holder's traffic, sessions and keys to another application. `idx_app_envs_domain` decides a race.

import type { AppEnvKind } from '@fabrika/control-contract'
import type { ControlRepositories } from '../../db'
import type { Env } from '../../env'
import { controlPublicOrigin } from '../../iam'
import { fail } from '../domain'

/**
 * The installation's own hosts, lowercase: Control's, which also serves the console, and IAM's issuer. A value that names
 * no host is skipped.
 */
export function reservedInstallationHosts(env: Pick<Env, 'FABRIKA_CONTROL_DOMAIN' | 'FABRIKA_IAM_ISSUER'>): readonly string[] {
	const hosts = new Set<string>()
	for (const origin of [controlPublicOrigin(env), env.FABRIKA_IAM_ISSUER?.trim()]) {
		if (origin === undefined || origin === '') continue
		try {
			const host = new URL(origin).hostname.toLowerCase()
			if (host !== '') hosts.add(host)
		} catch {
			// Not a URL: it names no host.
		}
	}
	return [...hosts]
}

/** Whether `domain` is `base` or a name under it; both lowercase. */
function isAtOrUnder(domain: string, base: string): boolean {
	return domain === base || domain.endsWith(`.${base}`)
}

/**
 * Refuse a domain the environment may not hold: one of the installation's own hosts or a name under it, or one another
 * environment holds. A `dev` environment's domain is a wildcard base (`<workspace id>.<base>`, ADR-0049), so it holds
 * every name under it against a standard environment; the dev environments of several applications may share one base.
 * Never names the other environment: the caller may not be allowed to see it.
 */
export async function assertDomainAvailable(
	c: { readonly repositories: ControlRepositories; readonly reservedHosts: readonly string[] },
	candidate: { readonly appId: string; readonly env: string; readonly kind: AppEnvKind },
	domain: string | null | undefined,
): Promise<void> {
	if (domain === undefined || domain === null || domain === '') return
	const normalized = domain.toLowerCase()
	const reserved = c.reservedHosts.find((host) => isAtOrUnder(normalized, host))
	if (reserved !== undefined) {
		fail(409, `domain ${domain} is ${reserved === normalized ? '' : 'under '}the installation's own host ${reserved}, which no application may take`)
	}
	const held = (await c.repositories.registry.listOtherAppEnvDomains(candidate)).some((other) => {
		if (candidate.kind === 'dev') return other.kind !== 'dev' && isAtOrUnder(other.domain, normalized)
		return other.kind === 'dev' ? isAtOrUnder(normalized, other.domain) : other.domain === normalized
	})
	if (held) {
		fail(409, `domain ${domain} is already held by another application environment; a domain serves one environment of the installation`)
	}
}
