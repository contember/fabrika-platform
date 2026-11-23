// The three apps a platform installation's proxy fronts — the third manifest generator
// [backlog 58](../../../docs/backlog/58-generate-the-platform-installations-proxy-manifest.md) asked
// for, beside the topology `@fabrika/provider-zerops/installation` owns.
//
// This is the ONE place the platform's app list is declared. The local composition builds its manifest
// from it (`packages/local-stack/src/prepare.ts`) and the committed artifact is rendered from it, so a
// table change reaches a deployed installation the same way it reaches the local stack — which is the
// whole item: the live document on `fabrika-test` was hand-written and made the entire control plane
// `public` for two days while the console's declaration said otherwise, and nothing reported it.
//
// DEV-TIME ONLY: it imports the service contracts from the PRIVATE service packages, which is why it
// lives in this private package. What a deploy command reads instead is `@fabrika/installation-init`'s
// `proxy-manifest.ts` (the types and `resolvePlatformProxyManifest`) plus `@fabrika/provider-zerops/installation`'s
// `src/installation/generated/platform-proxy-manifest.ts` (the tables, as data) — it never reaches this file.

import type { BodyAdmission, InstallationEndpointRow, InstallationEndpointTable } from '@fabrika/auth-core'
import {
	CONTROL_ACTIONS,
	CONTROL_APP_ID,
	CONTROL_CLI_PRESET_PARAMETER,
	CONTROL_CLI_PRESETS,
	CONTROL_CLI_RPC_GRANTS,
	CONTROL_OPERATIONS_RPC_PATH,
	CONTROL_RPC_PATH,
} from '@fabrika/control-contract'
import { controlSchema } from '@fabrika/control/schema'
import { CONTROL_MCP_PATH, CONTROL_MCP_SCOPE, controlServiceContract } from '@fabrika/control/service'
import { IAM_INSTALLATION_SERVICE_OPTIONS, iamServiceContract } from '@fabrika/iam/service'
import {
	type PlatformOAuthApp,
	type PlatformOAuthResourceTemplate,
	type PlatformOAuthScopeGrant,
	type PlatformProxyApp,
	type PlatformProxyManifestTemplate,
	resolvePlatformProxyManifest,
} from '@fabrika/installation-init'
import { OPERATIONS_ACTIONS, OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PUBLIC_SERVICE } from '@fabrika/operations/service'
import type { Artifact } from '@fabrika/provider-zerops/installation/topology'

export {
	type PlatformOAuthApp,
	type PlatformProxyApp,
	type PlatformProxyComposition,
	type PlatformProxyManifestTemplate,
	type PlatformProxyPlacement,
	type PlatformProxyService,
	resolvePlatformProxyManifest,
} from '@fabrika/installation-init'

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

/**
 * The console's MCP endpoint (ADR-0049). The `authoring` scope grants only what the MCP tools call;
 * IAM still intersects it with the user's own grants, so a token never exceeds its holder.
 */
const CONTROL_MCP_RESOURCE: PlatformOAuthResourceTemplate = {
	path: CONTROL_MCP_PATH,
	scopes: [CONTROL_MCP_SCOPE],
	defaultScopes: [CONTROL_MCP_SCOPE],
	scopeGrants: [{
		scope: CONTROL_MCP_SCOPE,
		actions: [
			CONTROL_ACTIONS.SOURCE_WORKSPACE_READ,
			CONTROL_ACTIONS.SOURCE_WORKSPACE_WRITE,
			CONTROL_ACTIONS.SOURCE_PULL_REQUEST_CREATE,
			CONTROL_ACTIONS.DEPLOY_TRIGGER,
			CONTROL_ACTIONS.DEPLOY_READ,
		],
	}],
}

/** The console's RPC, for the command-line client's device grant: one preset per scope (`@fabrika/control-contract`). */
const CONTROL_CLI_RPC_RESOURCE: PlatformOAuthResourceTemplate = {
	path: CONTROL_RPC_PATH,
	scopes: [...CONTROL_CLI_PRESETS],
	scopeGrants: CONTROL_CLI_RPC_GRANTS,
}

/**
 * Operations through the console, under the same presets: reading on `read` and `deploy`, triage on `operate`, nothing
 * on `create`. Managing sources, alerts and retention stays with a person in the console.
 */
const OPERATIONS_CLI_GRANTS: readonly PlatformOAuthScopeGrant[] = [
	{ scope: 'read', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: [OPERATIONS_ACTIONS.READ] },
	{ scope: 'deploy', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: [OPERATIONS_ACTIONS.READ] },
	{ scope: 'operate', parameter: CONTROL_CLI_PRESET_PARAMETER, actions: [OPERATIONS_ACTIONS.READ, OPERATIONS_ACTIONS.TRIAGE] },
]

/** The console's gateway forwards this path to Operations unchanged, and Operations verifies the token. */
const CONTROL_CLI_OPERATIONS_RESOURCE: PlatformOAuthResourceTemplate = {
	path: CONTROL_OPERATIONS_RPC_PATH,
	scopes: OPERATIONS_CLI_GRANTS.map((grant) => grant.scope),
	scopeGrants: OPERATIONS_CLI_GRANTS,
	verifiedBy: 'operations',
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
	// Every row is `protocol`: IAM authenticates each surface itself, and a credentialed row in front of its login page is a login loop.
	{
		id: PLATFORM_IAM_APP_ID,
		service: 'iam',
		port: 8080,
		upstream: 'iam:3000',
		table: serviceTable(iamServiceContract(IAM_INSTALLATION_SERVICE_OPTIONS)),
	},
	{
		id: CONTROL_APP_ID,
		service: 'control',
		port: 8082,
		upstream: 'control:3000',
		table: serviceTable(controlServiceContract({ mcp: false, cli: false })),
		oauth: {
			resources: [CONTROL_CLI_RPC_RESOURCE, CONTROL_CLI_OPERATIONS_RESOURCE],
			table: serviceTable(controlServiceContract({ mcp: false, cli: true })),
			mcp: { resource: CONTROL_MCP_RESOURCE, table: serviceTable(controlServiceContract({ mcp: true, cli: true })) },
		},
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
	'// fronts, at which private upstream, on which public listener, under which service table. The hosts and',
	'// the browser-facing scheme belong to ONE installation and are supplied at deploy time —',
	'// `resolvePlatformProxyManifest` binds them.',
	'//',
	"// The tables below are the services' own service contracts as of the last regeneration, copied on",
	'// purpose: a PUBLISHED deploy command may not import the private packages that own them. `gen:check` in',
	'// CI is what makes the copy a fact rather than a hope.',
	'//',
	"// The console's `oauth` half is copied the same way: the command-line client's resources and the table an",
	'// installation with an authorization server publishes, and MCP authoring on top. A deploy without one',
	'// publishes the plain `table`.',
	'',
].join('\n')

/** Single-quoted for dprint, with the two characters that could end the literal escaped. */
const quote = (value: string): string => `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

const list = (values: readonly string[]): string => `[${values.map(quote).join(', ')}]`

/** `indent` tabs, then the line. */
const at = (indent: number, line: string): string => `${'\t'.repeat(indent)}${line}`

const renderOAuthResource = (indent: number, open: string, resource: PlatformOAuthResourceTemplate): string[] => [
	at(indent, `${open}{`),
	at(indent + 1, `path: ${quote(resource.path)},`),
	at(indent + 1, `scopes: ${list(resource.scopes)},`),
	...(resource.defaultScopes === undefined ? [] : [at(indent + 1, `defaultScopes: ${list(resource.defaultScopes)},`)]),
	at(indent + 1, 'scopeGrants: ['),
	...resource.scopeGrants.flatMap((grant) => [
		at(indent + 2, '{'),
		at(indent + 3, `scope: ${quote(grant.scope)},`),
		...(grant.parameter === undefined ? [] : [at(indent + 3, `parameter: ${quote(grant.parameter)},`)]),
		at(indent + 3, `actions: ${list(grant.actions)},`),
		at(indent + 2, '},'),
	]),
	at(indent + 1, '],'),
	...(resource.verifiedBy === undefined ? [] : [at(indent + 1, `verifiedBy: ${quote(resource.verifiedBy)},`)]),
	at(indent, '},'),
]

const renderAdmission = (admission: BodyAdmission | null): string =>
	admission === null ? 'null' : `{ contentTypes: ${list(admission.contentTypes)}, maxBytes: ${admission.maxBytes ?? 'null'} }`

const renderRow = (indent: number, row: InstallationEndpointRow): string[] => [
	at(indent, '{'),
	at(indent + 1, `id: ${quote(row.id)},`),
	at(indent + 1, `kind: ${quote(row.kind)},`),
	at(indent + 1, `method: ${quote(row.method)},`),
	at(indent + 1, `path: ${quote(row.path)},`),
	at(indent + 1, `callers: ${list(row.callers)},`),
	at(indent + 1, `requirement: ${row.requirement === null ? 'null' : `{ kind: ${quote(row.requirement.kind)} }`},`),
	at(indent + 1, `admission: ${renderAdmission(row.admission)},`),
	at(indent + 1, `oauth: ${row.oauth === null ? 'null' : `{ scopes: ${list(row.oauth.scopes)} }`},`),
	at(indent, '},'),
]

const renderTable = (indent: number, table: InstallationEndpointTable): string[] => [
	at(indent, 'table: {'),
	at(indent + 1, 'endpoints: ['),
	...table.endpoints.flatMap((row) => renderRow(indent + 2, row)),
	at(indent + 1, '],'),
	at(indent + 1, `reservedPrefixes: ${list(table.reservedPrefixes)},`),
	at(indent, '},'),
]

const renderOAuth = (oauth: PlatformOAuthApp): string[] => [
	at(3, 'oauth: {'),
	at(4, 'resources: ['),
	...oauth.resources.flatMap((resource) => renderOAuthResource(5, '', resource)),
	at(4, '],'),
	...renderTable(4, oauth.table),
	...(oauth.mcp === undefined ? [] : [
		at(4, 'mcp: {'),
		...renderOAuthResource(5, 'resource: ', oauth.mcp.resource),
		...renderTable(5, oauth.mcp.table),
		at(4, '},'),
	]),
	at(3, '},'),
]

const renderApp = (app: PlatformProxyApp): string =>
	[
		'\t\t{',
		`\t\t\tid: ${quote(app.id)},`,
		`\t\t\tservice: ${quote(app.service)},`,
		`\t\t\tport: ${app.port},`,
		`\t\t\tupstream: ${quote(app.upstream)},`,
		...renderTable(3, app.table),
		...(app.oauth === undefined ? [] : renderOAuth(app.oauth)),
		'\t\t},',
	].join('\n')

/** A granted action the console's schema does not declare would be a scope that silently grants nothing. */
const assertDeclaredActions = (template: PlatformProxyManifestTemplate): void => {
	const declared = new Set(controlSchema.actions.map((entry) => entry.action))
	for (const app of template.apps) {
		const resources = app.oauth === undefined ? [] : [...app.oauth.resources, ...(app.oauth.mcp === undefined ? [] : [app.oauth.mcp.resource])]
		for (const grant of resources.flatMap((resource) => resource.scopeGrants)) {
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
	resolvePlatformProxyManifest(template, { scheme: 'https', placement: CHECK_PLACEMENT, mcp: false })
	for (const mcp of [false, true]) {
		resolvePlatformProxyManifest(template, { scheme: 'https', placement: CHECK_PLACEMENT, authorizationServer: 'https://iam.invalid', mcp })
	}
	assertDeclaredActions(template)
	const content = [
		HEADER,
		"import type { PlatformProxyManifestTemplate } from '@fabrika/installation-init'",
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
