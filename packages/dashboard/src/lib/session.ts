import type { RpcFetch } from '@fabrika/app'
import { type BuilderInstallationDiscoveryDto, parseBuilderInstallationDiscovery } from '@fabrika/control-contract'
import { type SignedInPrincipal, signedInPrincipal } from './iam'

const DISCOVERY_PATH = '/.well-known/fabrika-builder'

/** What the console's chrome knows about its own session. Either half may be unknown. */
export interface ConsoleSession {
	principal: SignedInPrincipal | null
	/** Null when the installation publishes no IAM origin on the console's host. */
	signOutUrl: string | null
}

/** The installation facts control publishes on the console's own origin, or null when it publishes none. */
export async function installationDiscovery(fetcher: RpcFetch = fetch): Promise<BuilderInstallationDiscoveryDto | null> {
	try {
		const response = await fetcher(DISCOVERY_PATH, { redirect: 'error' })
		if (!response.ok) return null
		const raw: unknown = await response.json()
		return parseBuilderInstallationDiscovery(raw)
	} catch {
		return null
	}
}

/**
 * IAM's sign-out confirmation. Its same-origin POST ends the IAM login and with it every app session derived from it,
 * the console's included; IAM refuses a cross-site POST, so the console links here rather than posting. IAM sends the
 * browser only to its own origin afterwards, so it goes on to IAM's sign-in page.
 */
export function signOutUrl(iamIssuer: string): string {
	const url = new URL('/auth/logout', iamIssuer)
	url.searchParams.set('redirect', new URL('/auth/login', iamIssuer).toString())
	return url.toString()
}

export async function readConsoleSession(fetcher: RpcFetch = fetch): Promise<ConsoleSession> {
	const [principal, discovery] = await Promise.all([signedInPrincipal(fetcher), installationDiscovery(fetcher)])
	return { principal, signOutUrl: discovery === null ? null : signOutUrl(discovery.iamIssuer) }
}
