// IAM's OAuth configuration for an installation (ADR-0049): the command-line client's resources on every composition
// with an authorization server, and MCP authoring, opt-in, on top.
//
// Everything is derived from the same template the proxy manifest is resolved from, so the two cannot disagree: each
// `oauth` row's registered resource in the manifest, and IAM's `FABRIKA_IAM_OAUTH_CONFIG`, which issues tokens for
// exactly those resources. The OAuth clients themselves are rows in IAM's registry (ADR-0089).

import type { OAuthResourceDto } from '@fabrika/iam-contract'
import { platformOAuthResourceUris, platformOAuthServed, type PlatformProxyComposition, type PlatformProxyManifestTemplate } from './proxy-manifest'

/** The document IAM parses from `FABRIKA_IAM_OAUTH_CONFIG`. */
export interface IamOAuthConfig {
	readonly resources: readonly OAuthResourceDto[]
	/** The installation's hostnames: IAM refuses an external application whose resource is on one (ADR-0089). */
	readonly hosts: readonly string[]
}

/** The operator's former OAuth client list. A deploy refuses it while it is set (ADR-0089 §5). */
export const MCP_CLIENTS_VARIABLE = 'FABRIKA_PLATFORM_MCP_CLIENTS_JSON'

/** The deploy setting that decides whether MCP authoring is on (ADR-0089 §4); unset is off. */
export const MCP_AUTHORING_VARIABLE = 'FABRIKA_PLATFORM_MCP_AUTHORING'

/** The switch as `on` or `off`, absent when unset; any other value is refused, naming where it came from. */
export const parseMcpAuthoring = (raw: string | undefined, name: string): boolean | undefined => {
	if (raw === undefined) return undefined
	if (raw === 'on') return true
	if (raw === 'off') return false
	throw new Error(`${name} must be on or off`)
}

/**
 * Refuse a deploy whose client list is still set, before it deploys anything; blank is unset, as `readEnv` reads it.
 * `name` is where the value came from, the variable or a flag.
 */
export const refuseMcpClientsVariable = (value: string | undefined, name: string): void => {
	if (value === undefined || value.trim() === '') return
	throw new Error(
		`${name} is set, and this release no longer reads it: IAM's registry holds the OAuth clients. To keep them, upgrade `
			+ 'through release v0.9.0-dev.47 first, whose deploy imports the list into the registry, then delete the variable. '
			+ 'Or delete it, deploy, and register the applications in the console or with `fabrika control external-apps` / '
			+ '`fabrika control oauth-clients` (registering adopts their existing roles); their sign-ins fail until then. '
			+ `Where MCP authoring was on, set ${MCP_AUTHORING_VARIABLE}=on.`,
	)
}

/**
 * IAM's OAuth configuration for one placed installation: every resource the composition registers, each marked for
 * the one kind of client it is served to, and the installation's hosts.
 */
export const platformIamOAuthConfig = (template: PlatformProxyManifestTemplate, composition: PlatformProxyComposition): IamOAuthConfig => {
	const resources: OAuthResourceDto[] = []
	for (const app of template.apps) {
		const served = platformOAuthServed(app, composition)
		for (const { template: entry, cli } of served?.resources ?? []) {
			const { resource } = platformOAuthResourceUris(composition, composition.placement[app.service].hosts, entry)
			resources.push({
				app: app.id,
				resource,
				...(entry.defaultScopes === undefined ? {} : { defaultScopes: [...entry.defaultScopes] }),
				scopeGrants: entry.scopeGrants.map((grant) => ({
					scope: grant.scope,
					...(grant.parameter === undefined ? {} : { parameter: grant.parameter }),
					permissions: grant.actions.map((action) => ({ action })),
				})),
				// IAM serves a resource to one kind of client: the command-line client's never reach an MCP client, nor MCP's it.
				...(cli ? { client: 'cli' } : {}),
			})
		}
	}
	if (resources.length === 0) {
		throw new Error('the platform proxy manifest template declares no OAuth resource on this composition')
	}
	const platformHosts = [...new Set(Object.values(composition.placement).flatMap((placement) => placement.hosts))]
	// IAM checks an external application registered at runtime against the same hosts.
	return { resources, hosts: platformHosts }
}
