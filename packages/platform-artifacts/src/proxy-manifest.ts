// The three apps a platform installation's proxy fronts — the third manifest generator
// [backlog 58](../../../docs/backlog/58-generate-the-platform-installations-proxy-manifest.md) asked
// for, beside the topology `@fabrika/provider-zerops/installation` owns.
//
// This is the ONE place the platform's app list is declared. The local composition builds its manifest
// from it (`packages/local-stack/src/prepare.ts`) and the committed artifact is rendered from it, so a
// gate change reaches a deployed installation the same way it reaches the local stack — which is the
// whole item: the live document on `fabrika-test` was hand-written and gated the entire control plane
// `public` for two days while `CONTROL_PROXY_GATES` said otherwise, and nothing reported it.
//
// DEV-TIME ONLY: it imports `CONTROL_PROXY_GATES` from the PRIVATE `@fabrika/control`, which is why it
// lives in this private package. What `@fabrika/provider-zerops/installation` ships instead is its
// `src/installation/proxy-manifest.ts` (the types and `resolvePlatformProxyManifest`) plus
// `src/installation/generated/platform-proxy-manifest.ts` (the gates, as data) — a deploy command reads those two and
// never reaches this file.

import type { BodyAdmission, GateRule, InstallationEndpointRow, InstallationEndpointTable } from '@fabrika/auth-core'
import { CONTROL_MCP_PATH, CONTROL_MCP_SCOPE, CONTROL_PROXY_GATES } from '@fabrika/control/gates'
import { controlSchema } from '@fabrika/control/schema'
import { IAM_INSTALLATION_SERVICE_OPTIONS, iamServiceContract } from '@fabrika/iam/service'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import {
	type PlatformOAuthResourceTemplate,
	type PlatformProxyApp,
	type PlatformProxyManifestTemplate,
	resolvePlatformProxyManifest,
} from '@fabrika/provider-zerops/installation'
import type { Artifact } from '@fabrika/provider-zerops/installation/topology'

export {
	type PlatformProxyApp,
	type PlatformProxyComposition,
	type PlatformProxyManifestTemplate,
	type PlatformProxyPlacement,
	type PlatformProxyService,
	resolvePlatformProxyManifest,
} from '@fabrika/provider-zerops/installation'

/**
 * IAM's own app id.
 *
 * Deliberately NOT `iam-local`, the name the live installation inherited when its manifest was copied
 * from the local composition during the 2026-08-03 bring-up. On a deployed installation that name is
 * simply false, and it is safe to correct because the id is INERT for an app whose every row is
 * `protocol`: the proxy admits it with no token and no IAM call, so the id never becomes a token
 * audience, never reaches `mintToken`/`mintFromKey`/`verify`, and never appears in a login bounce
 * (which only a `human` caller can produce). It is used for app SELECTION — the generated
 * Caddy route pins `?app=<id>` — but both sides of that lookup are generated from this one list, so they
 * cannot disagree. The remaining use is the proxy's log line, which is exactly where a false name costs
 * something.
 */
export const PLATFORM_IAM_APP_ID = 'iam'

/** The console's app id — the name its IAM schema, roles and grants are already registered under. */
export const PLATFORM_CONSOLE_APP_ID = 'vozka'

/**
 * The console's MCP endpoint (ADR-0049). The `authoring` scope grants only what the MCP tools call;
 * IAM still intersects it with the user's own grants, so a token never exceeds its holder.
 */
const CONTROL_MCP_RESOURCE: PlatformOAuthResourceTemplate = {
	path: CONTROL_MCP_PATH,
	scopes: [CONTROL_MCP_SCOPE],
	scopeGrants: [{
		scope: CONTROL_MCP_SCOPE,
		actions: ['source.workspace.read', 'source.workspace.write', 'source.pull-request.create', 'deploy.trigger', 'deploy.read'],
	}],
}

/** A service contract as template data: its rows and reserved prefixes, without the service's id. */
const serviceTable = ({ endpoints, reservedPrefixes }: InstallationEndpointTable): InstallationEndpointTable => ({ endpoints, reservedPrefixes })

/**
 * The apps, in manifest order.
 *
 * `port` is the public listener each answers on, and these three are the first three of
 * `PROXY_PUBLIC_PORTS` in `provider-zerops/src/installation/topology/setups.ts` (8081 is the unpublished health
 * listener); the rest of that pool are application slots. Written out rather than sliced off that list on purpose: on the subdomain path
 * the port IS the hostname, so reassigning one must show up as a diff in the committed artifact instead
 * of silently moving IAM's public address.
 */
export const PLATFORM_PROXY_APPS: readonly PlatformProxyApp[] = [
	// Every row is `protocol`: IAM authenticates each surface itself, and a gate in front of its login page is a login loop.
	{
		id: PLATFORM_IAM_APP_ID,
		service: 'iam',
		port: 8080,
		upstream: 'iam:3000',
		table: serviceTable(iamServiceContract(IAM_INSTALLATION_SERVICE_OPTIONS)),
	},
	{
		id: PLATFORM_CONSOLE_APP_ID,
		service: 'control',
		port: 8082,
		upstream: 'control:3000',
		gates: CONTROL_PROXY_GATES,
		oauthResource: CONTROL_MCP_RESOURCE,
	},
	{ id: OPERATIONS_APP_ID, service: 'operations', port: 8083, upstream: 'operations:3000', table: serviceTable(OPERATIONS_PUBLIC_SERVICE) },
]

/** The installation-independent half of every platform proxy manifest. */
export const platformProxyManifestTemplate = (): PlatformProxyManifestTemplate => ({ apps: PLATFORM_PROXY_APPS })

/** Repo-relative path of the committed template. */
export const PLATFORM_PROXY_MANIFEST_PATH = 'packages/provider-zerops/src/installation/generated/platform-proxy-manifest.ts'

/**
 * Distinct, legal stand-in hosts, used only to prove the template resolves. A failure under these is the
 * TEMPLATE's fault — a duplicate app id, a malformed rule, an empty upstream — and never the caller's.
 */
const CHECK_PLACEMENT = {
	iam: { hosts: ['iam.invalid'] },
	control: { hosts: ['control.invalid'] },
	operations: { hosts: ['operations.invalid'] },
}

const HEADER = [
	'// GENERATED FILE — DO NOT EDIT BY HAND.',
	'//',
	'// Source: packages/platform-artifacts/src/proxy-manifest.ts',
	'// Regenerate: bun run --filter @fabrika/platform-artifacts gen',
	'//',
	'// The installation-independent half of `FABRIKA_PROXY_MANIFEST_JSON`: which apps the platform proxy',
	'// fronts, at which private upstream, on which public listener, under which gates or service table. The',
	'// hosts and the browser-facing scheme belong to ONE installation and are supplied at deploy time —',
	'// `resolvePlatformProxyManifest` binds them.',
	'//',
	"// The gate rules and service tables below are the services' own (`CONTROL_PROXY_GATES`, IAM's and",
	"// Operations' service contracts) as of the last regeneration, copied on purpose: a PUBLISHED deploy command",
	'// may not import the private packages that own them. `gen:check` in CI is what makes the copy a fact',
	'// rather than a hope.',
	'//',
	"// The console's `oauthResource` is its MCP endpoint, copied the same way. A deploy gates and registers",
	'// it only on an installation that enables MCP authoring.',
	'',
].join('\n')

/** Single-quoted for dprint, with the two characters that could end the literal escaped. */
const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const renderRule = (rule: GateRule): string => {
	const credential = rule.kind === 'service' && rule.credential !== undefined
		? `, credential: { in: ${quote(rule.credential.in)}, name: ${quote(rule.credential.name)} }`
		: ''
	return `{ path: ${quote(rule.path)}, kind: ${quote(rule.kind)}${credential} }`
}

const renderOAuthResource = (resource: PlatformOAuthResourceTemplate): string[] => [
	'\t\t\toauthResource: {',
	`\t\t\t\tpath: ${quote(resource.path)},`,
	`\t\t\t\tscopes: [${resource.scopes.map(quote).join(', ')}],`,
	'\t\t\t\tscopeGrants: [',
	...resource.scopeGrants.flatMap((grant) => [
		'\t\t\t\t\t{',
		`\t\t\t\t\t\tscope: ${quote(grant.scope)},`,
		`\t\t\t\t\t\tactions: [${grant.actions.map(quote).join(', ')}],`,
		'\t\t\t\t\t},',
	]),
	'\t\t\t\t],',
	'\t\t\t},',
]

const list = (values: readonly string[]): string => `[${values.map(quote).join(', ')}]`

const renderAdmission = (admission: BodyAdmission | null): string =>
	admission === null ? 'null' : `{ contentTypes: ${list(admission.contentTypes)}, maxBytes: ${admission.maxBytes ?? 'null'} }`

const renderRow = (row: InstallationEndpointRow): string[] => [
	'\t\t\t\t\t{',
	`\t\t\t\t\t\tid: ${quote(row.id)},`,
	`\t\t\t\t\t\tkind: ${quote(row.kind)},`,
	`\t\t\t\t\t\tmethod: ${quote(row.method)},`,
	`\t\t\t\t\t\tpath: ${quote(row.path)},`,
	`\t\t\t\t\t\tcallers: ${list(row.callers)},`,
	`\t\t\t\t\t\trequirement: ${row.requirement === null ? 'null' : `{ kind: ${quote(row.requirement.kind)} }`},`,
	`\t\t\t\t\t\tadmission: ${renderAdmission(row.admission)},`,
	`\t\t\t\t\t\toauth: ${row.oauth === null ? 'null' : `{ scopes: ${list(row.oauth.scopes)} }`},`,
	'\t\t\t\t\t},',
]

const renderAccess = (app: PlatformProxyApp): string[] =>
	app.table === undefined
		? [
			'\t\t\tgates: {',
			'\t\t\t\trules: [',
			...app.gates.rules.map((rule) => `\t\t\t\t\t${renderRule(rule)},`),
			'\t\t\t\t],',
			'\t\t\t},',
		]
		: [
			'\t\t\ttable: {',
			'\t\t\t\tendpoints: [',
			...app.table.endpoints.flatMap(renderRow),
			'\t\t\t\t],',
			`\t\t\t\treservedPrefixes: ${list(app.table.reservedPrefixes)},`,
			'\t\t\t},',
		]

const renderApp = (app: PlatformProxyApp): string =>
	[
		'\t\t{',
		`\t\t\tid: ${quote(app.id)},`,
		`\t\t\tservice: ${quote(app.service)},`,
		`\t\t\tport: ${app.port},`,
		`\t\t\tupstream: ${quote(app.upstream)},`,
		...renderAccess(app),
		...(app.oauthResource === undefined ? [] : renderOAuthResource(app.oauthResource)),
		'\t\t},',
	].join('\n')

/** A granted action the console's schema does not declare would be a scope that silently grants nothing. */
const assertDeclaredActions = (template: PlatformProxyManifestTemplate): void => {
	const declared = new Set(controlSchema.actions.map((entry) => entry.action))
	for (const app of template.apps) {
		for (const grant of app.oauthResource?.scopeGrants ?? []) {
			const unknown = grant.actions.filter((action) => !declared.has(action))
			if (unknown.length > 0) {
				throw new Error(`\`${app.id}\` grants undeclared action(s) under \`${grant.scope}\`: ${unknown.join(', ')}`)
			}
		}
	}
}

/** The committed template, as a typed module: `typecheck` then proves the artifact still fits its type. */
export const platformProxyManifestArtifact = (): Artifact => {
	const template = platformProxyManifestTemplate()
	// Refuse to commit a template the proxy's own parser would reject.
	resolvePlatformProxyManifest(template, { scheme: 'https', placement: CHECK_PLACEMENT })
	resolvePlatformProxyManifest(template, { scheme: 'https', placement: CHECK_PLACEMENT, authorizationServer: 'https://iam.invalid' })
	assertDeclaredActions(template)
	const content = [
		HEADER,
		"import type { PlatformProxyManifestTemplate } from '../proxy-manifest'",
		'',
		'export const PLATFORM_PROXY_MANIFEST_TEMPLATE: PlatformProxyManifestTemplate = {',
		'\tapps: [',
		...template.apps.map(renderApp),
		'\t],',
		'}',
		'',
	].join('\n')
	return { path: PLATFORM_PROXY_MANIFEST_PATH, content }
}
