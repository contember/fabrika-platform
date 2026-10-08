// The proxy manifest a platform installation is configured with, split into the half that is the same
// on every installation and the half that is one account's.
//
// ── Why a template rather than a `ProxyManifest` with the hosts left out ──────────────────────────
//
// `parseProxyManifest` refuses an app that declares no hosts, and rightly — a host-less app is fronted
// by nothing and gates nothing. So the committed half cannot BE a manifest with empty hosts; it is a
// type of its own, and `resolvePlatformProxyManifest` is the one way to turn it into the document the
// proxy parses.
//
// ── The split ────────────────────────────────────────────────────────────────────────────────────
//
//   template   which apps exist, their ids, the private service each is dialed at, the public listener
//              each answers on, and their gates. True of every installation, so it is GENERATED into
//              `src/generated/` and reviewed in a diff.
//   placement  the hostnames and the browser-facing scheme. `proxy-292c-8080.prg1.zerops.app` names one
//              account's project, and a production installation binds custom domains instead, so
//              whoever is deploying supplies these.
//
// Nothing in this file imports the packages that OWN the gates. That is the point of the split: the
// gate sets live in `@fabrika/control` (private) and reach a deployed installation as DATA, through the
// generated artifact, so the published deploy path never depends on a package it cannot resolve.

import type { AppGates, GateRule } from '@fabrika/auth-core'
import {
	type GateProxyApp,
	type GateProxyManifest,
	isContractProxyApp,
	type OAuthProtectedResource,
	parseProxyManifest,
} from '@fabrika/proxy-core/manifest'

/** The platform services an installation's proxy fronts. Each name is a service hostname in the topology. */
export type PlatformProxyService = 'iam' | 'control' | 'operations'

/** What one OAuth scope lets a token do: the owning app's actions, resolved by IAM at the token endpoint. */
export interface PlatformOAuthScopeGrant {
	readonly scope: string
	readonly actions: readonly string[]
}

/**
 * A path an app serves to OAuth clients, protected only on an installation that enables it.
 *
 * The resource URI is the app's public origin plus `path`, so the template holds the path and a deploy
 * binds the origin. Copied from the owning gate module by the generator, like `gates`.
 */
export interface PlatformOAuthResourceTemplate {
	readonly path: string
	readonly scopes: readonly string[]
	readonly scopeGrants: readonly PlatformOAuthScopeGrant[]
}

/** One fronted app, in the form that is the same on every installation. */
export interface PlatformProxyApp {
	/** The IAM app id. It is the audience of every token the proxy mints for this app's host. */
	readonly id: string
	/** The topology service that answers for it. */
	readonly service: PlatformProxyService
	/**
	 * The proxy's public listener this app answers on.
	 *
	 * On a `zerops-subdomain` installation a port IS a hostname — Zerops mints one generated host per
	 * HTTP port — so this is the only installation-independent half of `hosts`. A custom-domain
	 * installation ignores it: every domain arrives on one listener and the `Host` header decides.
	 */
	readonly port: number
	/** Where the proxy dials it over the project's private network. */
	readonly upstream: string
	/** Owned by the service's own gate module and copied in by the generator. Never written by hand. */
	readonly gates: AppGates
	/** Present only on an app that can serve OAuth clients; off unless the composition names an authorization server. */
	readonly oauthResource?: PlatformOAuthResourceTemplate
}

/** Everything about an installation's manifest that does not depend on WHICH installation it is. */
export interface PlatformProxyManifestTemplate {
	readonly apps: readonly PlatformProxyApp[]
}

/**
 * The template's entry for one platform service.
 *
 * The app IDS live in the template, so a caller that needs one — the deploy's schema reconcile needs
 * the console's — reads it from there rather than restating a literal that could drift from the
 * document the proxy is actually configured with.
 */
export const platformProxyAppFor = (
	template: PlatformProxyManifestTemplate,
	service: PlatformProxyService,
): PlatformProxyApp => {
	const app = template.apps.find((candidate) => candidate.service === service)
	if (app === undefined) {
		throw new Error(`the platform proxy manifest template fronts no \`${service}\` service`)
	}
	return app
}

/** Where one app answers in a particular composition. */
export interface PlatformProxyPlacement {
	/** Public hostnames, without a port — `parseProxyManifest` refuses a `:port` suffix. */
	readonly hosts: readonly string[]
	/** Overrides the private dial address. The local composition runs IAM on a port of its own. */
	readonly upstream?: string
}

/** One composition of the platform: a deployed installation, or the local Docker stack. */
export interface PlatformProxyComposition {
	/** The scheme the BROWSER speaks to these apps — configuration, never a header (see `ProxyApp.scheme`). */
	readonly scheme: 'http' | 'https'
	readonly placement: Readonly<Record<PlatformProxyService, PlatformProxyPlacement>>
	/**
	 * The public IAM origin that issues OAuth tokens. Present only when the installation enables MCP
	 * authoring; absent leaves every `oauthResource` unregistered and ungated.
	 */
	readonly authorizationServer?: string
	/** The port browsers reach every app on, when it is not the scheme's default. The local composition's is 18080. */
	readonly publicPort?: number
}

/**
 * The RFC 8707 resource URI and RFC 9728 metadata URL of an app's OAuth resource, bound to the app's
 * FIRST host: the proxy refuses a resource on a host the app does not answer on.
 */
export const platformOAuthResourceUris = (
	composition: Pick<PlatformProxyComposition, 'scheme' | 'publicPort'>,
	hosts: readonly string[],
	template: PlatformOAuthResourceTemplate,
): { readonly resource: string; readonly resourceMetadata: string } => {
	const host = hosts[0]
	if (host === undefined) {
		throw new Error('an OAuth resource needs a host to stand on')
	}
	const origin = composition.publicPort === undefined
		? `${composition.scheme}://${host}`
		: `${composition.scheme}://${host}:${composition.publicPort}`
	return {
		resource: `${origin}${template.path}`,
		resourceMetadata: `${origin}/.well-known/oauth-protected-resource${template.path}`,
	}
}

/** The gate rule goes FIRST, so the app's own catch-all rules cannot claim the path before it. */
const withOAuthResource = (
	app: GateProxyApp,
	template: PlatformOAuthResourceTemplate,
	composition: PlatformProxyComposition,
	authorizationServer: string,
): GateProxyApp => {
	const { resource, resourceMetadata } = platformOAuthResourceUris(composition, app.hosts, template)
	const rule: GateRule = { path: template.path, kind: 'oauth', resource, scopes: [...template.scopes] }
	const registered: OAuthProtectedResource = {
		resource,
		resourceMetadata,
		authorizationServers: [authorizationServer],
		scopesSupported: [...template.scopes],
	}
	return { ...app, gates: { rules: [rule, ...app.gates.rules] }, oauthResources: [registered] }
}

/**
 * Bind a template to one composition and get the document the proxy actually parses.
 *
 * The result is returned THROUGH `parseProxyManifest`, so a duplicate id, a repeated host or a `:port`
 * suffix is refused right here instead of at a deployed proxy's next build.
 */
export const resolvePlatformProxyManifest = (
	template: PlatformProxyManifestTemplate,
	composition: PlatformProxyComposition,
): GateProxyManifest => {
	const apps = template.apps.map((app): GateProxyApp => {
		const placement = composition.placement[app.service]
		const resolved: GateProxyApp = {
			id: app.id,
			hosts: [...placement.hosts],
			upstream: placement.upstream ?? app.upstream,
			gates: app.gates,
			scheme: composition.scheme,
		}
		return app.oauthResource === undefined || composition.authorizationServer === undefined
			? resolved
			: withOAuthResource(resolved, app.oauthResource, composition, composition.authorizationServer)
	})
	const manifest = parseProxyManifest({ apps })
	// Every platform service is protected by gates, so the parsed manifest holds gate apps only.
	const gateApps = manifest?.apps.flatMap((app) => isContractProxyApp(app) ? [] : [app]) ?? []
	if (manifest === null || gateApps.length !== manifest.apps.length) {
		throw new Error('the resolved platform proxy manifest is not one the proxy would accept')
	}
	return { apps: gateApps }
}
