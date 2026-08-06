// The three apps a platform installation's proxy fronts — the third manifest generator
// [backlog 58](../../../docs/backlog/58-generate-the-platform-installations-proxy-manifest.md) asked
// for, beside the topology this package already owns.
//
// This is the ONE place the platform's app list is declared. The local composition builds its manifest
// from it (`packages/local-stack/src/prepare.ts`) and the committed artifact is rendered from it, so a
// gate change reaches a deployed installation the same way it reaches the local stack — which is the
// whole item: the live document on `fabrika-test` was hand-written and gated the entire control plane
// `public` for two days while `CONTROL_PROXY_GATES` said otherwise, and nothing reported it.
//
// DEV-TIME ONLY, and the shape of this package is arranged around that. It imports `CONTROL_PROXY_GATES`
// from the PRIVATE `@fabrika/control` through a devDependency, so it is excluded from the published
// `files` together with `render.ts`, its only caller here. What ships instead is `../src/proxy-manifest`
// (the types and `resolvePlatformProxyManifest`) plus `generated/platform-proxy-manifest.ts` (the gates,
// as data) — a deploy command reads those two and never reaches this file.

import type { AppGates, GateRule } from '@fabrika/auth-core'
import { CONTROL_PROXY_GATES } from '@fabrika/control/gates'
import { OPERATIONS_APP_ID } from '@fabrika/operations-contract'
import { OPERATIONS_PROXY_GATES } from '@fabrika/operations/gates'
import type { PlatformProxyApp, PlatformProxyManifestTemplate } from '../src/proxy-manifest'
import { resolvePlatformProxyManifest } from '../src/proxy-manifest'
import type { Artifact } from './artifacts'

export {
	type PlatformProxyApp,
	type PlatformProxyComposition,
	type PlatformProxyManifestTemplate,
	type PlatformProxyPlacement,
	type PlatformProxyService,
	resolvePlatformProxyManifest,
} from '../src/proxy-manifest'

/**
 * IAM's own app id.
 *
 * Deliberately NOT `iam-local`, the name the live installation inherited when its manifest was copied
 * from the local composition during the 2026-08-03 bring-up. On a deployed installation that name is
 * simply false, and it is safe to correct because the id is INERT for an app whose every rule is
 * `public`: gate matching returns `allow` on the first rule with no token and no IAM call, so the id
 * never becomes a token audience, never reaches `mintToken`/`mintFromKey`/`verify`, and never appears in
 * a login bounce (which only a `human` miss can produce). It is used for app SELECTION — the generated
 * Caddy route pins `?app=<id>` — but both sides of that lookup are generated from this one list, so they
 * cannot disagree. The remaining use is the proxy's log line, which is exactly where a false name costs
 * something.
 */
export const PLATFORM_IAM_APP_ID = 'iam'

/** The console's app id — the name its IAM schema, roles and grants are already registered under. */
export const PLATFORM_CONSOLE_APP_ID = 'vozka'

/**
 * IAM authenticates itself: its login, JWKS and admin surfaces own their own authorization, and a gate
 * in front of the login page is a login loop. Written out rather than imported because there is no gate
 * module to import — IAM declares no gates at all, by design.
 */
const IAM_PROXY_GATES: AppGates = { rules: [{ path: '/*', kind: 'public' }] }

/**
 * The apps, in manifest order.
 *
 * `port` is the public listener each answers on, and these three are the first three of
 * `PROXY_PUBLIC_PORTS` in `./setups.ts` (8081 is the unpublished health listener); the rest of that pool
 * are application slots. Written out rather than sliced off that list on purpose: on the subdomain path
 * the port IS the hostname, so reassigning one must show up as a diff in the committed artifact instead
 * of silently moving IAM's public address.
 */
export const PLATFORM_PROXY_APPS: readonly PlatformProxyApp[] = [
	{ id: PLATFORM_IAM_APP_ID, service: 'iam', port: 8080, upstream: 'iam:3000', gates: IAM_PROXY_GATES },
	{ id: PLATFORM_CONSOLE_APP_ID, service: 'control', port: 8082, upstream: 'control:3000', gates: CONTROL_PROXY_GATES },
	{ id: OPERATIONS_APP_ID, service: 'operations', port: 8083, upstream: 'operations:3000', gates: OPERATIONS_PROXY_GATES },
]

/** The installation-independent half of every platform proxy manifest. */
export const platformProxyManifestTemplate = (): PlatformProxyManifestTemplate => ({ apps: PLATFORM_PROXY_APPS })

/** Repo-relative path of the committed template. */
export const PLATFORM_PROXY_MANIFEST_PATH = 'packages/installation-zerops/zerops/generated/platform-proxy-manifest.ts'

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
	'// Source: packages/installation-zerops/zerops/proxy-manifest.ts',
	'// Regenerate: bun run --filter @fabrika/installation-zerops gen',
	'//',
	'// The installation-independent half of `FABRIKA_PROXY_MANIFEST_JSON`: which apps the platform proxy',
	'// fronts, at which private upstream, on which public listener, under which gates. The hosts and the',
	'// browser-facing scheme belong to ONE installation and are supplied at deploy time —',
	'// `resolvePlatformProxyManifest` binds them.',
	'//',
	'// The gate rules below are `CONTROL_PROXY_GATES` and `OPERATIONS_PROXY_GATES` as of the last',
	'// regeneration, copied on purpose: a PUBLISHED deploy command may not import the private package that',
	'// owns them. `gen:check` in CI is what makes the copy a fact rather than a hope.',
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

const renderApp = (app: PlatformProxyApp): string =>
	[
		'\t\t{',
		`\t\t\tid: ${quote(app.id)},`,
		`\t\t\tservice: ${quote(app.service)},`,
		`\t\t\tport: ${app.port},`,
		`\t\t\tupstream: ${quote(app.upstream)},`,
		'\t\t\tgates: {',
		'\t\t\t\trules: [',
		...app.gates.rules.map((rule) => `\t\t\t\t\t${renderRule(rule)},`),
		'\t\t\t\t],',
		'\t\t\t},',
		'\t\t},',
	].join('\n')

/** The committed template, as a typed module: `typecheck` then proves the artifact still fits its type. */
export const platformProxyManifestArtifact = (): Artifact => {
	const template = platformProxyManifestTemplate()
	// Refuse to commit a template the proxy's own parser would reject.
	resolvePlatformProxyManifest(template, { scheme: 'https', placement: CHECK_PLACEMENT })
	const content = [
		HEADER,
		"import type { PlatformProxyManifestTemplate } from '../../src/proxy-manifest'",
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
