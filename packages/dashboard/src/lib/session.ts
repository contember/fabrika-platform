import { createRpcClient, type RpcFetch } from '@fabrika/app'
import {
	type BuilderInstallationDiscoveryDto,
	type ConsoleAccessDto,
	type ControlRpcContract,
	parseBuilderInstallationDiscovery,
} from '@fabrika/control-contract'
import type { ConsoleCaller } from './console-access'
import { administersPeople, type IamAdministration, iamAdministration, type SignedInPrincipal } from './iam'

const DISCOVERY_PATH = '/.well-known/fabrika-builder'

/** What the console's chrome knows about its own session and what its caller may use. Any part may be unknown. */
export interface ConsoleSession extends ConsoleCaller {
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

/** Control's answer for the caller's token, or null when Control does not give one; never a login bounce. */
async function consoleAccess(fetcher: RpcFetch): Promise<ConsoleAccessDto | null> {
	try {
		return await createRpcClient<ControlRpcContract>({ baseUrl: '/api/rpc', fetch: fetcher, bounceOnAuth: false }).consoleAccess()
	} catch {
		return null
	}
}

/** Control names every caller; IAM's `me` names an administrator when Control does not answer. */
function signedInPrincipal(access: ConsoleAccessDto | null, administration: IamAdministration): SignedInPrincipal | null {
	return access?.principal ?? (administration.status === 'admin' ? administration.principal : null)
}

export async function readConsoleSession(fetcher: RpcFetch = fetch): Promise<ConsoleSession> {
	const [access, administration, people, discovery] = await Promise.all([
		consoleAccess(fetcher),
		iamAdministration(fetcher),
		administersPeople(fetcher),
		installationDiscovery(fetcher),
	])
	return {
		principal: signedInPrincipal(access, administration),
		signOutUrl: discovery === null ? null : signOutUrl(discovery.iamIssuer),
		access,
		iamAdmin: administration.status === 'unknown' ? null : administration.status === 'admin',
		administersPeople: people,
	}
}

let current: Promise<ConsoleSession> | null = null

/** One read per console load, shared by the chrome and the loaders that show or hide by it. */
export function consoleSession(): Promise<ConsoleSession> {
	current ??= readConsoleSession()
	return current
}
